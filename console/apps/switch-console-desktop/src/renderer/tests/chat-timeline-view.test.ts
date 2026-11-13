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
    namedUserIds: [],
    mentions: [],
    threadReplyCount: 0,
    threadLastReplySeq: null,
    kickoff: null,
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
        people: [],
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
        people: [],
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

describe('ChatTimelineView mentions', () => {
  const cc = {
    id: 'a3',
    name: 'cc',
    displayName: null,
    iconUrl: null,
    provider: null,
    alias: null,
    ownerName: null,
    ownedByViewer: false,
  };
  const render = (namedUserIds: string[], namedAgentIds: string[]) => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({ ...message(1, 'me', 'Alice'), body: '@cc hi', namedUserIds, namedAgentIds });
    return renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [cc],
        people: [{ userId: 'u2', name: 'cc' }],
        activities: [],
        onReply: () => {},
      })
    );
  };

  it('shows a person the message names as the person, even with an agent of the same name', () => {
    expect(render(['u2'], [])).toContain('data-mention="person"');
  });

  it('shows the agent when the message names no person', () => {
    expect(render([], ['a3'])).toContain('data-mention="agent"');
  });
});

describe('ChatTimelineView mentions of people no longer in the chat', () => {
  it('still badges a person the message names, from the wider list of known people', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({
      ...message(1, 'me', 'Alice'),
      body: 'thanks @Carol Gone',
      namedUserIds: ['u9'],
    });
    const html = renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [],
        people: [{ userId: 'u9', name: 'Carol Gone' }],
        activities: [],
        onReply: () => {},
      })
    );
    expect(html).toContain('data-mention="person"');
  });
});

describe('ChatTimelineView mentions from the server’s spans', () => {
  it('badges a same-name agent and person each as itself, after an emoji', () => {
    const body = '🎉 @Bob Member and @Bob Member';
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({
      ...message(1, 'me', 'Alice'),
      body,
      mentions: [
        { kind: 'agent', id: 'a9', offset: body.indexOf('@'), length: 11 },
        { kind: 'user', id: 'u1', offset: body.lastIndexOf('@'), length: 11 },
      ],
    });
    const html = renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [
          {
            id: 'a9',
            name: 'Bob Member',
            displayName: null,
            iconUrl: null,
            provider: null,
            alias: null,
            ownerName: null,
            ownedByViewer: false,
          },
        ],
        people: [{ userId: 'u1', name: 'Bob Member' }],
        activities: [],
        onReply: () => {},
      })
    );
    expect([...html.matchAll(/data-mention="(\w+)"[^>]*>@Bob Member</g)].map((m) => m[1])).toEqual([
      'agent',
      'person',
    ]);
  });
});

describe('ChatTimelineView kickoffs', () => {
  const system = { clientId: '', name: '', kind: 'system' as const, agentId: null, userId: null };
  const render = (timeline: ChatTimeline) =>
    renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [],
        people: [],
        activities: [],
        onReply: () => {},
      })
    );

  it('shows a kickoff as its runner’s request, with the agents’ note folded away', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({ ...message(1, '', ''), sender: system, body: 'Kickoff from switch-buddy' });
    timeline.apply({
      ...message(2, '', ''),
      sender: system,
      threadRootId: 'm1',
      body: 'Sprint room is live. Post today’s standup.',
      kickoff: {
        name: 'switch-buddy',
        agentId: 'buddy-1',
        userId: 'me',
        agentNote: 'Note for the agents: this room is part of a run.',
      },
    });
    const html = render(timeline);

    // The headline is not repeated as a centred notice above the request.
    expect(html).not.toContain('Kickoff from switch-buddy');
    expect(html).not.toContain('text-center');
    expect(html).toContain('switch-buddy');
    expect(html).toContain('>Kickoff<');
    expect(html).toContain('Sprint room is live.');
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details for agents<\/summary>/);
    expect(html).toContain('Note for the agents: this room is part of a run.');
  });

  it('still shows a Switch notice that is not a kickoff as a centred line', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({ ...message(1, '', ''), sender: system, body: 'Session reset.' });
    const html = render(timeline);

    expect(html).toContain('text-center');
    expect(html).not.toContain('>Kickoff<');
  });
});
