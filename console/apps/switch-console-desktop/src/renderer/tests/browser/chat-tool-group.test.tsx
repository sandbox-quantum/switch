/**
 * A turn's tool calls: only the latest gets a full line, the ones before it
 * fold into one "N tool calls" line that names failures and opens in place.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatActivityBlock } from '@renderer/features/chats/components/chat-activity-block';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import type { ChatActivityItem } from '@shared/core/chats/activity';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function item(itemId: string, status: string, title = ''): ChatActivityItem {
  return {
    agentId: 'agent-a',
    sessionId: 's1',
    turnId: 't1',
    itemId,
    kind: itemId === 'turn' ? 'turn' : 'tool-activity',
    revision: 1,
    status,
    title,
    text: '',
    commandId: null,
    roomId: 'room-1',
    threadId: null,
    messageId: 'm1',
    occurredAt: `2026-01-01T00:00:0${itemId.replace(/\D/g, '') || 0}Z`,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as ChatActivityItem;
}

async function render(items: ChatActivityItem[]): Promise<HTMLDivElement> {
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'session',
      target: { kind: 'local' } as never,
      hostAgentKey: 'agent-local',
      sessionId: 's1',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items, approvals: [] }),
    roomMessages: () => [],
    control: vi.fn(),
    retrySupport: async () => 'no',
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const activities = new AgentActivities(api, { getItem: () => null, setItem: () => {} });
  const activity = activities.acquire('server', 'tenant', 'room-1', 'agent-a');
  await vi.waitFor(() => expect(activity.turns().size).toBe(1));
  const turn = activity.turns().get('m1')!;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatActivityBlock
          activity={activity}
          turn={turn}
          agent={{ name: 'helper', iconUrl: null }}
          head
          endReason={null}
          serverId="server"
        />
      </QueryClientProvider>
    )
  );
  return container;
}

const rows = (el: HTMLElement) =>
  [...el.querySelectorAll('[data-slot="work-log-row"]')].map((r) => r.textContent ?? '');

it('folds the earlier calls of a running turn and keeps the latest on its own line', async () => {
  const el = await render([
    item('turn', 'running'),
    item('tool1', 'completed', 'Bash git status'),
    item('tool2', 'failed', 'Bash git push'),
    item('tool3', 'completed', 'Bash git log'),
    item('tool4', 'in_progress', 'Bash git remote -v'),
  ]);
  const group = [...el.querySelectorAll('button')].find((b) =>
    b.textContent?.startsWith('3 tool calls')
  )!;
  expect(group.textContent).toContain('· 1 failed');
  expect(group.getAttribute('aria-expanded')).toBe('false');
  expect(rows(el).filter((r) => r.includes('git remote -v'))).toHaveLength(1);
  expect(el.textContent).not.toContain('git status');

  await act(async () => group.click());
  expect(group.getAttribute('aria-expanded')).toBe('true');
  expect(el.textContent).toContain('git status');
  expect(el.textContent).toContain('git push');
});

it('shows a single call with no group line', async () => {
  const el = await render([item('turn', 'completed'), item('tool1', 'completed', 'Bash ls')]);
  expect(el.textContent).not.toMatch(/tool calls?/);
  expect(el.textContent).toContain('ls');
});

it('shows each message steered into the turn, including after it completed', async () => {
  const el = await render([
    item('turn', 'completed'),
    { ...item('initial', 'completed'), kind: 'user-message', text: 'Initial request' },
    {
      ...item('steered1', 'completed'),
      kind: 'user-message',
      text: 'Use the other file',
      delivery: 'steered',
    },
    {
      ...item('steered2', 'completed'),
      kind: 'user-message',
      text: 'And skip the tests',
      delivery: 'steered',
    },
  ]);
  expect(rows(el)).toEqual([
    'Steered into this turn: Use the other file',
    'Steered into this turn: And skip the tests',
  ]);
  expect(el.textContent).not.toContain('Initial request');
});

it('says a queued turn waits behind the running one when its message arrived mid-turn', async () => {
  const el = await render([
    item('turn', 'queued'),
    {
      ...item('queued', 'completed'),
      kind: 'user-message',
      text: 'Run the tests next',
      delivery: 'queued',
    },
  ]);
  expect(el.textContent).toContain('Queued behind the running turn…');
  expect(el.textContent).not.toContain('Steered');
});
