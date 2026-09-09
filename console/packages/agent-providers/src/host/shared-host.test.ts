import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command, HostEvent, Session } from '@switch-console/shared/session-v1';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import { runSharedHost } from './shared-host';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('executes server commands and uploads cancellation without server-owned events', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shared-host-test-'));
  roots.push(root);
  const stop = new AbortController();
  const events: HostEvent[] = [];
  const issued = new Set<string>();
  let listener: (event: ProviderRuntimeEvent) => void = () => {};
  let live = false;
  const emit = (event: Record<string, unknown>) =>
    listener({
      ...event,
      sessionId: 'session',
      provider: 'claude',
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
    } as ProviderRuntimeEvent);
  const adapter: ProviderAdapter = {
    provider: 'claude',
    capabilities: {
      resume: true,
      steering: false,
      approvals: true,
      userInput: true,
      modelSwitchInSession: false,
    },
    startSession: vi.fn(async () => {
      live = true;
      emit({ type: 'session.state.changed', status: 'ready' });
      return { provider: 'claude', sessionId: 'session', nativeSessionId: 'native' };
    }),
    sendTurn: vi.fn(async ({ turnId }) => {
      emit({ type: 'turn.started', turnId });
      emit({
        type: 'request.opened',
        turnId,
        requestId: 'permission',
        requestType: 'tool_approval',
        title: 'Write file',
        options: [{ decision: 'cancel', label: 'Cancel' }],
      });
      return { turnId };
    }),
    respondToRequest: vi.fn(async () => {}),
    respondToUserInput: vi.fn(async () => {}),
    interruptTurn: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {
      live = false;
    }),
    stopAll: vi.fn(async () => {}),
    hasSession: () => live,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = () => {};
      };
    },
  };
  const session: Session = {
    sessionId: 'session',
    agentId: 'agent',
    hostId: 'host',
    epoch: 'proposed',
    provider: 'claude',
    status: 'starting',
    connectivity: 'online',
    pendingRequestIds: [],
    capabilities: {
      input: 'queue',
      approvals: true,
      questions: true,
      interrupt: false,
      reset: false,
      compact: false,
      modelChange: false,
      attachmentMimeTypes: [],
    },
  };
  const command = (id: string, body: Command['body']): Command => ({
    contractVersion: 1,
    commandId: id,
    sessionId: 'session',
    epoch: 'server-epoch',
    origin: {
      actorId: 'verified-owner',
      surface: 'slack',
      roomId: 'room',
      threadId: null,
      messageId: 'card',
    },
    body,
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      let result: unknown;
      if (path.endsWith('/claim'))
        result = {
          contractVersion: 1,
          throughSequence: 1,
          session: { ...session, epoch: 'server-epoch' },
          turns: [],
          items: [],
          requests: [],
          commandStatuses: [],
          nextPageToken: null,
        };
      else if (path.endsWith('/events')) {
        const event = JSON.parse(options.body as string) as HostEvent;
        events.push(event);
        result = { throughHostSequence: event.hostSequence };
      } else if (path.endsWith('/commands')) {
        if (
          !issued.has('turn') &&
          events.some(
            (event) => event.body.type === 'session.upsert' && event.body.session.status === 'ready'
          )
        ) {
          issued.add('turn');
          result = [
            command('turn', {
              type: 'message.send',
              delivery: 'queue',
              text: 'Hello',
              attachments: [],
            }),
          ];
        } else if (
          events.some((event) => event.body.type === 'request.opened') &&
          !issued.has('answer')
        ) {
          issued.add('answer');
          result = [
            command('answer', {
              type: 'request.answer',
              requestId: 'permission',
              expectedRevision: 1,
              answer: { kind: 'approval', optionId: '0' },
            }),
          ];
        } else result = [];
      } else result = { leaseSeconds: 30 };
      return Response.json(result);
    })
  );
  const running = runSharedHost(
    {
      root: join(root, 'session'),
      agentApiUrl: 'http://127.0.0.1/agent',
      token: randomUUID(),
      session,
      input: {
        sessionId: 'session',
        cwd: root,
        runtimeMode: 'approval-required',
        env: {},
        mcpServers: {},
      },
    },
    adapter,
    stop.signal
  );
  const outcome = running.then(
    () => null,
    (error: unknown) => error
  );
  try {
    await vi.waitFor(
      () =>
        expect(
          events.some(
            (event) => event.body.type === 'command.result' && event.body.commandId === 'answer'
          )
        ).toBe(true),
      { timeout: 3000 }
    );
    expect(adapter.respondToRequest).toHaveBeenCalledExactlyOnceWith(
      'session',
      'permission',
      'cancel'
    );
    expect(events.map((event) => event.hostSequence)).toEqual(events.map((_, index) => index + 1));
    expect(events.every((event) => event.epoch === 'server-epoch')).toBe(true);
    expect(events.find((event) => event.body.type === 'request.settled')?.body).toMatchObject({
      outcome: 'cancelled',
      result: null,
      commandId: 'answer',
    });
    expect(
      events.some((event) => ['request.submitting', 'command.status'].includes(event.body.type))
    ).toBe(false);
  } finally {
    stop.abort();
    expect(await outcome).toBeNull();
  }
  expect(adapter.stopSession).toHaveBeenCalled();
});
