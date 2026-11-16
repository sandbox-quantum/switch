/**
 * Switch's replies in a room's chat, in real CSS: a one-line notice is
 * centred, and a command's longer reply (the `!help` list) is laid out like a
 * message, left-aligned, with its list as a list.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import '@renderer/index.css';
import { ChatTimelineView } from '@renderer/features/chats/components/chat-timeline';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
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

function fromSwitch(seq: number, body: string): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId: 'room-1',
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: '', name: '', kind: 'system', agentId: null, userId: null },
    source: 'switch',
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

const HELP = [
  '**Available commands:**',
  '- `!help` — Show this list of commands.',
  '- `!list-agents` — List the agents in this room.',
  '- `!follow-ups` — Let agents answer follow-ups.',
].join('\n');

it('lays out a command’s reply like a message, and still centres a one-line notice', async () => {
  const timeline = new ChatTimeline('room-1', {} as TimelineApi);
  timeline.apply(fromSwitch(1, 'helper joined the room'));
  timeline.apply(fromSwitch(2, HELP));

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
          agents={[]}
          people={[]}
          activities={[]}
          onReply={() => {}}
        />
      </QueryClientProvider>
    )
  );

  const notice = container.querySelector<HTMLElement>('#chat-message-m1')!;
  const help = container.querySelector<HTMLElement>('#chat-message-m2')!;
  expect(getComputedStyle(notice).textAlign).toBe('center');
  expect(getComputedStyle(help).textAlign).not.toBe('center');
  expect(help.querySelectorAll('li')).toHaveLength(3);
  for (const item of help.querySelectorAll('li'))
    expect(getComputedStyle(item).textAlign).not.toBe('center');
});
