import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import '@renderer/index.css';
import { ChatActivityBlock } from '@renderer/features/chats/components/chat-activity-block';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import { avatarSettingsQueryKey } from '@renderer/lib/stores/use-avatar-settings';
import type { ChatActivityItem } from '@shared/core/chats/activity';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function turnItem(status: ChatActivityItem['status']): ChatActivityItem {
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    turnId: 't1',
    itemId: 'turn',
    kind: 'turn',
    revision: 1,
    status,
    title: '',
    text: '',
    commandId: null,
    roomId: 'room-1',
    threadId: null,
    messageId: 'm1',
    occurredAt: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

/**
 * The block as a room draws it: a real activity over an API whose session says
 * it can retry, so a turn that may be run again is offered Retry and one that
 * may not is drawn without it for that reason alone.
 */
async function render(status: ChatActivityItem['status']): Promise<HTMLDivElement> {
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'session',
      target: { kind: 'local' } as never,
      hostAgentKey: 'agent-local',
      sessionId: 's1',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items: [turnItem(status)], approvals: [] }),
    roomMessages: () => [],
    control: vi.fn(),
    retrySupport: async () => 'yes',
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const activities = new AgentActivities(api, { getItem: () => null, setItem: () => {} });
  const activity = activities.acquire('server-1', 'tenant', 'room-1', 'agent-a');
  await vi.waitFor(() => expect(activity.turns().size).toBe(1));
  await vi.waitFor(() => expect(activity.target).not.toBeNull());
  const turn = activity.turns().get('m1')!;
  expect(turn.status).toBe(status);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  // The agent's avatar reads its server's avatar setting; seeded, it is fresh
  // and never asked for.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: Infinity } },
  });
  client.setQueryData(avatarSettingsQueryKey('server-1'), { thirdPartyAvatarsEnabled: false });
  await act(async () =>
    root!.render(
      <QueryClientProvider client={client}>
        <ChatActivityBlock
          activity={activity}
          turn={turn}
          agent={{ name: 'Helper', iconUrl: null }}
          head
          endReason={null}
          serverId="server-1"
        />
      </QueryClientProvider>
    )
  );
  for (let i = 0; i < 5; i++) await act(async () => await Promise.resolve());
  return container;
}

const retryButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) => /^Retr/.test(b.textContent ?? ''));

const cancelButton = (el: HTMLElement) =>
  [...el.querySelectorAll('button')].find((b) =>
    /cancel/i.test(`${b.textContent ?? ''} ${b.getAttribute('aria-label') ?? ''}`)
  );

function statusOf(el: HTMLElement): HTMLElement {
  const status = el.querySelector<HTMLElement>('[role="status"]');
  expect(status).not.toBeNull();
  return status!;
}

describe('ChatActivityBlock', () => {
  it('shows a cancelled turn as cancelled, without the failure mark or Retry', async () => {
    const el = await render('cancelled');

    const status = statusOf(el);
    expect(status.textContent).toBe('Cancelled');
    expect(status.querySelector('.text-foreground-destructive')).toBeNull();
    expect(el.textContent).not.toContain('t1');
    // Withdrawn by its sender: there is nothing to run again.
    expect(retryButton(el)).toBeUndefined();
    expect(cancelButton(el)).toBeUndefined();
  });

  it('offers no way to cancel a queued turn from its card', async () => {
    const el = await render('queued');

    expect(el.textContent).toContain('Queued…');
    expect(cancelButton(el)).toBeUndefined();
  });

  it('keeps the failure mark, and Retry, for a turn that ended with an error', async () => {
    const el = await render('error');

    const status = statusOf(el);
    expect(status.querySelector('.text-foreground-destructive')).not.toBeNull();
    expect(retryButton(el)).toBeDefined();
  });
});
