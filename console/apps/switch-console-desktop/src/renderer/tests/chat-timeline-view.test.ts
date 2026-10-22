import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatTimelineView } from '@renderer/features/chats/components/chat-timeline';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import type { ChatMessage } from '@shared/core/chats/chats';

vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {} }));
// The viewer is Alice.
vi.mock('@renderer/features/chats/stores/chats', () => ({ chatsStore: { userId: 'me' } }));
vi.mock('@renderer/lib/stores/use-avatar-settings', () => ({
  useAvatarSettings: () => ({ thirdPartyAvatarsEnabled: false }),
  useThirdPartyAvatarsEnabled: () => false,
}));

function message(seq: number, userId: string, name: string): ChatMessage {
  return {
    messageId: `m${seq}`,
    seq,
    roomId: 'room-1',
    sentAt: '2026-01-01T00:00:00Z',
    sender: { clientId: 'c', name, kind: 'human', agentId: null, userId },
    source: 'console',
    body: `body ${seq}`,
    format: null,
    threadRootId: null,
    attachments: [],
    clientTxn: null,
    namedAgentIds: [],
    threadReplyCount: 0,
    threadLastReplySeq: null,
  };
}

const api = {} as TimelineApi;

describe('ChatTimelineView', () => {
  it('lays out every human message the same way, the viewer’s included', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply(message(1, 'me', 'Alice'));
    timeline.apply(message(2, 'other', 'Bob'));
    const html = renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [],
        activities: [],
        onReply: () => {},
      })
    );
    expect(html).not.toContain('items-end');
    expect(html).toContain('title="Alice"');
    expect(html).toContain('title="Bob"');
    expect(html.match(/aria-label="Reply"/g)).toHaveLength(2);
  });
});

describe('ChatTimelineView thread replies', () => {
  it('puts the reply reference under the sender and above the body, for agents and people alike', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply(message(1, 'me', 'Alice'));
    timeline.apply({
      ...message(2, 'agent-user', 'helper'),
      sender: { clientId: 'h', name: 'helper', kind: 'agent', agentId: 'a1', userId: null },
      threadRootId: 'm1',
      body: 'agent reply',
    });
    timeline.apply({ ...message(3, 'other', 'Bob'), threadRootId: 'm1', body: 'person reply' });
    const html = renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [],
        activities: [],
        onReply: () => {},
      })
    );
    for (const [name, body] of [
      ['>helper<', 'agent reply'],
      ['>Bob<', 'person reply'],
    ]) {
      const from = html.indexOf(name);
      const chip = html.indexOf('reply to', from);
      expect(from).toBeGreaterThan(-1);
      expect(chip).toBeGreaterThan(from);
      expect(html.indexOf(body, from)).toBeGreaterThan(chip);
    }
  });
});
