/**
 * A template's kickoff in a room's chat, in real CSS: a card naming who sent
 * it, with that agent's own picture, and the run history for the agents folded
 * away. Saves a screenshot under the app's gitignored `build/acceptance/`.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { page } from 'vitest/browser';
import buddyAvatar from '@/assets/images/switch-buddy/avatar.png';
import '@renderer/index.css';
import { ChatTimelineView } from '@renderer/features/chats/components/chat-timeline';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import type { ChatAgent, ChatMessage } from '@shared/core/chats/chats';

vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: { userId: 'me' } }));

const SHOTS = '../../../../build/acceptance/kickoff';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  document.documentElement.classList.remove('emdark');
});

function message(seq: number, overrides: Partial<ChatMessage>): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId: 'room-1',
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: '', name: '', kind: 'system', agentId: null, userId: null },
    source: 'switch',
    body: '',
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
    ...overrides,
  };
}

const tracker: ChatAgent = {
  id: 'tracker',
  name: 'flint-sprint-tracker',
  displayName: 'Flint Sprint Tracker',
  iconUrl: null,
  provider: 'codex',
  alias: null,
  ownerName: 'Simon Flack',
  ownedByViewer: true,
};

it('draws a kickoff as a card from the agent that sent it', async () => {
  document.documentElement.classList.add('emdark');
  const timeline = new ChatTimeline('room-1', {} as TimelineApi);
  timeline.apply(
    message(1, {
      sender: {
        clientId: 'c-t',
        name: 'flint-sprint-tracker',
        kind: 'agent',
        agentId: 'tracker',
        userId: null,
      },
      body: 'Hi! I’m here to help — mention flint-sprint-tracker anytime.',
    })
  );
  timeline.apply(
    message(2, { body: 'Kickoff from switch-buddy-simon-flack, Simon Flack’s agent' })
  );
  timeline.apply(
    message(3, {
      threadRootId: 'm2',
      body:
        'Sprint room is live for Flint. flint-sprint-tracker is tracking progress. Post ' +
        'today’s standup update and flag any blockers, and mention the sprint tracker so it ' +
        'sees it. The agents only see messages that mention them by name.',
      kickoff: {
        name: 'switch-buddy-simon-flack',
        agentId: 'buddy',
        userId: 'me',
        agentNote:
          'Note for the agents: this room is part of a run that started in Welcome. So far:\n\n' +
          '1. Welcome (a person’s room): Switch Console chat with switch-buddy-simon-flack\n' +
          '2. this room (created by switch-buddy-simon-flack)',
        displayName: 'Switch Buddy',
        iconUrl: buddyAvatar,
      },
    })
  );
  timeline.apply(
    message(4, {
      sender: {
        clientId: 'c-t',
        name: 'flint-sprint-tracker',
        kind: 'agent',
        agentId: 'tracker',
        userId: null,
      },
      body: 'Tracking is set up. No standups have been posted yet.',
    })
  );

  container = document.createElement('div');
  container.className = 'bg-background p-6 text-foreground';
  container.style.width = '820px';
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(
      <QueryClientProvider client={new QueryClient()}>
        <ChatTimelineView
          serverId="srv-1"
          timeline={timeline}
          agents={[tracker]}
          people={[]}
          activities={[]}
          onReply={() => {}}
        />
      </QueryClientProvider>
    )
  );
  await page.viewport(900, 700);

  expect(container.textContent).toContain('Kickoff from Switch Buddy');
  expect(container.textContent).not.toContain('Kickoff from switch-buddy-simon-flack');
  await page.screenshot({ path: `${SHOTS}/kickoff-card.png`, element: container });

  await act(async () => container!.querySelector('details')!.setAttribute('open', ''));
  await page.screenshot({ path: `${SHOTS}/kickoff-card-details-open.png`, element: container });
});
