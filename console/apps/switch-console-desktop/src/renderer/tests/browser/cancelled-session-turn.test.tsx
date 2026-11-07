/** A cancellation receipt is not the host-confirmed end of the queued turn. */
import {
  SessionChatClient,
  type ServerEvent,
  type SessionTransport,
  type Snapshot,
} from '@switch-console/shared/session-v1';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionV1Chat } from '@renderer/features/sessions/components/transcript/session-v1-chat';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

it('preserves the original message and shows cancellation only after the host turn update', async () => {
  const snapshot: Snapshot = {
    contractVersion: 1,
    throughSequence: 1,
    nextPageToken: null,
    session: {
      sessionId: 'session-demo',
      agentId: 'agent-demo',
      provider: 'claude',
      hostId: 'host-demo',
      epoch: 'epoch-demo',
      status: 'ready',
      connectivity: 'online',
      capabilities: {
        input: 'queue',
        approvals: true,
        questions: true,
        interrupt: true,
        reset: false,
        compact: false,
        modelChange: false,
        attachmentMimeTypes: [],
      },
      pendingRequestIds: [],
    },
    turns: [
      { type: 'turn.upsert', turnId: 'turn-demo', status: 'queued', commandId: 'message-demo' },
    ],
    items: [
      {
        itemId: 'original',
        turnId: 'turn-demo',
        revision: 1,
        kind: 'user-message',
        status: 'completed',
        title: '',
        text: 'An outdated request I sent.',
        attachments: [],
        origin: null,
      },
    ],
    requests: [],
    notices: [],
    commandStatuses: [],
  };
  let receive: (event: unknown) => void = () => {};
  const submit = vi.fn(async () => {
    throw new Error('No control should be submitted by rendering.');
  });
  const transport: SessionTransport = {
    snapshot: async () => snapshot,
    subscribe: (_id, _after, listener) => {
      receive = listener;
      return () => {};
    },
    submit,
    commandStatus: async () => {
      throw new Error('No command reconciliation expected.');
    },
  };
  const client = new SessionChatClient('session-demo', transport);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<SessionV1Chat client={client} />));
  await vi.waitFor(() => expect(container!.textContent).toContain('Message queued'));
  const update = (sequence: number, body: ServerEvent['body']): ServerEvent => ({
    contractVersion: 1,
    eventId: `event-${sequence}`,
    sessionId: 'session-demo',
    sequence,
    occurredAt: '2026-01-01T00:00:00Z',
    body,
  });
  await act(async () =>
    receive(
      update(2, {
        type: 'command.status',
        commandId: 'cancel-demo',
        status: 'applied',
        code: null,
        message: null,
      })
    )
  );
  expect(container.textContent).toContain('Message queued');
  expect(container.textContent).not.toContain('Turn cancelled');
  await act(async () =>
    receive(
      update(3, {
        type: 'turn.upsert',
        turnId: 'turn-demo',
        status: 'cancelled',
        commandId: 'message-demo',
      })
    )
  );
  expect(container.textContent).toContain('An outdated request I sent.');
  expect(container.textContent).toContain('Turn cancelled before starting.');
  expect(container.textContent).not.toContain('Message queued');
  expect(container.querySelector('[aria-label="Still writing"]')).toBeNull();
  expect(submit).not.toHaveBeenCalled();
  expect(
    [...container.querySelectorAll('button')].some((button) =>
      /cancel/i.test(button.textContent ?? '')
    )
  ).toBe(false);
});
