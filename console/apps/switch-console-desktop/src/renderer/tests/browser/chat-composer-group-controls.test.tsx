/**
 * In a group chat Stop reaches whichever agent is working, and Reset or
 * Compact goes to the agent picked, or to all of them.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());

import { ChatComposer } from '@switch-console/chat-ui/components/chat-composer';
import type { ChatActivityItem } from '@switch-console/chat-ui/contracts/activity';
import type { ChatAgent } from '@switch-console/chat-ui/contracts/chats';
import { ChatHostProvider } from '@switch-console/chat-ui/host';
import {
  type ActivityApi,
  AgentActivities,
} from '@switch-console/chat-ui/stores/chat-activity-store';
import { ChatTimeline, type TimelineApi } from '@switch-console/chat-ui/stores/chat-timeline-store';
import { stubChatHost } from '@switch-console/chat-ui/testing';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  toast.mockClear();
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const agent = (id: string, name: string): ChatAgent => ({
  id,
  name,
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: false,
});

const runningTurn: ChatActivityItem = {
  agentId: 'agent-b',
  sessionId: 's1',
  turnId: 't1',
  itemId: 'turn',
  kind: 'turn',
  revision: 1,
  status: 'running',
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

async function render(post: ActivityApi['control'] = async (input) => `cmd-${input.requestId}`) {
  const control = vi.fn<ActivityApi['control']>(post);
  const api: ActivityApi = {
    resolve: async () => ({ kind: 'none' }) as never,
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items: [runningTurn], approvals: [] }),
    roomMessages: () => [],
    control,
    retrySupport: async () => 'unknown',
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const store = new AgentActivities(api, {
    getItem: () => null,
    setItem: () => {},
  });
  const activities = ['agent-a', 'agent-b'].map((id) => store.acquire('s', 'tenant', 'room-1', id));
  await vi.waitFor(() => expect(activities[1]!.runningTurn).not.toBeNull());
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider host={stubChatHost({ toast })}>
          <ChatComposer
            serverId="s"
            timeline={new ChatTimeline('room-1', {} as TimelineApi)}
            agents={[agent('agent-a', 'Alpha'), agent('agent-b', 'Beta')]}
            people={[]}
            groupName="Ship review"
            activities={activities}
            replyTo={null}
            onClearReply={() => {}}
            disabled={null}
          />
        </ChatHostProvider>
      </QueryClientProvider>
    )
  );
  return control;
}

const button = (label: string | RegExp) =>
  [...document.body.querySelectorAll('button')].find((each) =>
    typeof label === 'string'
      ? each.getAttribute('aria-label') === label || each.textContent?.trim() === label
      : label.test(each.textContent ?? '')
  );

const click = (label: string | RegExp) =>
  act(async () => {
    const found = button(label);
    if (!found) throw new Error(`no button ${label}`);
    found.click();
  });

const sent = (control: ReturnType<typeof vi.fn>) =>
  control.mock.calls.map(([input]) => [input.agentId, input.command]);

it('shows Stop when only the second agent is working, and stops that agent', async () => {
  const control = await render();
  expect(button('Stop reply')).toBeDefined();
  await click('Stop reply');
  expect(sent(control)).toEqual([['agent-b', 'interrupt']]);
});

it('resets only the agent picked, naming it before it is sent', async () => {
  const control = await render();
  await click('Context actions');
  await click(/^Reset context/);
  expect(document.body.textContent).toContain('Reset which agent?');
  await click(/Beta$/);
  expect(document.body.textContent).toContain('Start a fresh conversation for Beta?');
  await click('Start fresh');
  expect(sent(control)).toEqual([['agent-b', 'reset']]);
});

it('compacts every agent when all are picked', async () => {
  const control = await render();
  await click('Context actions');
  await click(/^Compact context/);
  await click('All agents');
  expect(sent(control)).toEqual([
    ['agent-a', 'compact'],
    ['agent-b', 'compact'],
  ]);
});

it('shows Stop next to Send when agent is working and user has typed a draft', async () => {
  const control = await render();
  const textarea = document.querySelector('textarea');
  expect(textarea).toBeDefined();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
      textarea,
      'test message'
    );
    textarea!.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await vi.waitFor(() => {
    const stopButton = button('Stop reply');
    const sendButton = button('Send');
    expect(stopButton).toBeDefined();
    expect(sendButton).toBeDefined();
  });
  await click('Stop reply');
  expect(sent(control)).toEqual([['agent-b', 'interrupt']]);
});

it('shows Stop next to Send when agent is working and user has attached a file', async () => {
  const control = await render();
  const fileInput = document.querySelector('input[type="file"]');
  expect(fileInput).toBeDefined();
  const file = new File(['content'], 'test.txt', { type: 'text/plain' });
  await act(async () => {
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      writable: false,
    });
    fileInput!.dispatchEvent(new Event('change', { bubbles: true }));
  });
  const stopButton = button('Stop reply');
  const sendButton = button('Send');
  expect(stopButton).toBeDefined();
  expect(sendButton).toBeDefined();
  await click('Stop reply');
  expect(sent(control)).toEqual([['agent-b', 'interrupt']]);
});

it('names the agent a command failed for when all agents are picked', async () => {
  const control = await render(async (input) => {
    if (input.agentId === 'agent-a') throw new Error('offline');
    return `cmd-${input.requestId}`;
  });
  await click('Context actions');
  await click(/^Compact context/);
  await click('All agents');
  expect(sent(control)).toEqual([
    ['agent-a', 'compact'],
    ['agent-b', 'compact'],
  ]);
  await vi.waitFor(() =>
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Compact failed for Alpha.', variant: 'destructive' })
    )
  );
});

it('blocks only the agent whose command is still being sent', async () => {
  await render((input) =>
    input.agentId === 'agent-a' ? new Promise(() => {}) : Promise.resolve(`cmd-${input.requestId}`)
  );
  await click('Context actions');
  await click(/^Compact context/);
  await click(/Alpha$/);
  await click('Context actions');
  await click(/^Compact context/);
  expect(button(/Alpha$/)?.disabled).toBe(true);
  expect(button('All agents')?.disabled).toBe(true);
  expect(button(/Beta$/)?.disabled).toBe(false);
});
