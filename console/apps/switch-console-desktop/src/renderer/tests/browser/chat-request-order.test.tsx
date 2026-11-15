/**
 * An agent's question form reads after the text its turn posted before it,
 * not above it under the person's message that started the turn.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatTimelineView } from '@renderer/features/chats/components/chat-timeline';
import {
  type ActivityApi,
  AgentActivities,
} from '@renderer/features/chats/stores/chat-activity-store';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import type { ChatActivityItem, ChatApproval } from '@shared/core/chats/activity';
import type { ChatMessage } from '@shared/core/chats/chats';

vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: { userId: 'me' } }));

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

function item(itemId: string, second: number, status: string, title = ''): ChatActivityItem {
  const at = `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`;
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
    occurredAt: at,
    createdAt: at,
    updatedAt: at,
  };
}

const question: ChatApproval = {
  agentId: 'agent-a',
  sessionId: 's1',
  requestId: 'req-1',
  turnId: 't1',
  kind: 'questions',
  roomId: 'room-1',
  threadId: null,
  title: 'Question from the agent',
  detail: null,
  options: [],
  questions: [
    {
      id: 'q1',
      title: 'Agent',
      prompt: 'Which agent would you like me to set up?',
      options: [
        { id: 'a', label: 'bakery-orders', description: null },
        { id: 'b', label: 'bakery-pantry', description: null },
      ],
      multiSelect: false,
      allowCustomAnswer: false,
    },
  ],
  state: 'open',
  expiresAt: null,
  answer: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
};

function message(seq: number, second: number, body: string, agentId: string | null): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId: 'room-1',
    sentAt: `2026-01-01T00:00:${String(second).padStart(2, '0')}Z`,
    sender: agentId
      ? { clientId: 'c-a', name: 'buddy', kind: 'agent', agentId, userId: null }
      : { clientId: 'c-me', name: 'Maya', kind: 'human', agentId: null, userId: 'me' },
    source: 'console',
    body,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
    namedAgentIds: [],
    namedUserIds: [],
    mentions: [],
    threadReplyCount: 0,
    threadLastReplySeq: null,
    kickoff: null,
  };
}

it('shows the question form after the text the turn posted, in reading order', async () => {
  // The turn ran a tool before it posted, so the turn itself shows under the person's message.
  const items = [item('turn', 1, 'running'), item('tool1', 2, 'completed', 'Bash ls')];
  const api: ActivityApi = {
    resolve: async () => ({
      kind: 'session',
      target: { kind: 'local' } as never,
      hostAgentKey: 'agent-local',
      sessionId: 's1',
    }),
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items, approvals: [question] }),
    roomMessages: () => [],
    control: vi.fn(),
    retrySupport: async () => 'no',
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const activity = new AgentActivities(api, { getItem: () => null, setItem: () => {} }).acquire(
    'server',
    'tenant',
    'room-1',
    'agent-a'
  );
  await vi.waitFor(() => expect(activity.turns().size).toBe(1));
  const timeline = new ChatTimeline('room-1', {} as TimelineApi);
  timeline.apply(message(1, 0, 'I run a small bakery', null));
  timeline.apply(message(2, 3, 'Here are two agents that could help.', 'agent-a'));
  timeline.apply(message(3, 4, 'Pick one below.', 'agent-a'));

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatTimelineView
          serverId="server"
          timeline={timeline}
          agents={[]}
          people={[]}
          activities={[activity]}
          onReply={() => {}}
        />
      </QueryClientProvider>
    )
  );

  const text = container.textContent ?? '';
  expect(text).toContain('Which agent would you like me to set up?');
  // The turn's work log still sits under the person's message, above the agent's text.
  const workLog = container.querySelector('[data-turn-id="t1"]')!;
  expect(text.indexOf(workLog.textContent ?? '')).toBeLessThan(text.indexOf('Here are two agents'));
  expect(workLog.textContent).not.toContain('Which agent would you like me to set up?');
  expect(text.indexOf('Pick one below.')).toBeLessThan(
    text.indexOf('Which agent would you like me to set up?')
  );
  expect(text.match(/Which agent would you like me to set up\?/g)).toHaveLength(1);
});
