import { ChatComposer } from '@switch-console/chat-ui/components/chat-composer';
import type { ChatApproval } from '@switch-console/chat-ui/contracts/activity';
import type { ChatAgent } from '@switch-console/chat-ui/contracts/chats';
import { ChatHostProvider } from '@switch-console/chat-ui/host';
import {
  type ActivityApi,
  AgentActivities,
} from '@switch-console/chat-ui/stores/chat-activity-store';
import { ChatTimeline, type TimelineApi } from '@switch-console/chat-ui/stores/chat-timeline-store';
import { stubChatHost } from '@switch-console/chat-ui/testing';
/**
 * A message typed while an agent waits on a question is not taken as the
 * answer: it waits its turn. The composer says so and points at the question,
 * so the person is not left watching "queued".
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
});

const buddy: ChatAgent = {
  id: 'agent-a',
  name: 'switch-buddy',
  displayName: null,
  iconUrl: null,
  provider: null,
  alias: null,
  ownerName: null,
  ownedByViewer: true,
};

const question = (state: string): ChatApproval => ({
  requestId: 'req-1',
  agentId: 'agent-a',
  sessionId: 's1',
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
      title: 'Room',
      prompt: 'Which room should I set up?',
      options: [{ id: 'a', label: 'Sprint Room', description: null }],
      multiSelect: false,
      allowCustomAnswer: false,
    },
  ],
  state,
  expiresAt: null,
  answer: null,
  answers: null,
  answeredBy: null,
  answeredAt: null,
});

async function render(state: string) {
  const api: ActivityApi = {
    resolve: async () => ({ kind: 'none' }) as never,
    reasoning: async () => null,
    watchPlacements: () => () => {},
    roomActivity: async () => ({ items: [], approvals: [question(state)] }),
    roomMessages: () => [],
    control: async () => 'cmd',
    retrySupport: async () => 'unknown',
    answerApproval: async () => {
      throw new Error('unused');
    },
  };
  const store = new AgentActivities(api, { getItem: () => null, setItem: () => {} });
  const activity = store.acquire('s', 'tenant', 'room-1', 'agent-a');
  await vi.waitFor(() => expect(activity.approvals.size).toBe(1));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatHostProvider host={stubChatHost()}>
          <ChatComposer
            serverId="s"
            timeline={new ChatTimeline('room-1', {} as TimelineApi)}
            agents={[buddy]}
            people={[]}
            groupName={null}
            activities={[activity]}
            replyTo={null}
            onClearReply={() => {}}
            disabled={null}
          />
        </ChatHostProvider>
      </QueryClientProvider>
    )
  );
}

async function type(text: string) {
  const box = container!.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(box, text);
    box.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const nudge = () => container!.querySelector('[data-testid="question-waiting"]');

it('asks whether a message typed while a question is open was meant as the answer', async () => {
  await render('open');
  expect(nudge()).toBeNull();

  await type('yes go ahead');

  expect(nudge()?.textContent).toContain(
    'switch-buddy is waiting for your answer to the question above.'
  );
  expect(nudge()?.textContent).toContain('Did you mean to answer it?');
  expect(nudge()?.querySelector('button')?.textContent).toBe('Go to the question');
});

it('says nothing once the question is answered', async () => {
  await render('answered');
  await type('thanks');
  expect(nudge()).toBeNull();
});
