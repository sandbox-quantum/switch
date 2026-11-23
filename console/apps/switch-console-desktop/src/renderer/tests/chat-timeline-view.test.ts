import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { type ChatEntrance, NO_ENTRANCE } from '@renderer/features/chats/chat-entrance';
import { ChatTimelineView } from '@renderer/features/chats/components/chat-timeline';
import {
  ChatTimeline,
  type TimelineApi,
} from '@renderer/features/chats/stores/chat-timeline-store';
import { recordOwnBuddy } from '@renderer/features/switch-buddy/own-buddies';
import type { ChatAgent, ChatMessage } from '@shared/core/chats/chats';

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
        entrance: NO_ENTRANCE,
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
        entrance: NO_ENTRANCE,
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
        entrance: NO_ENTRANCE,
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
        entrance: NO_ENTRANCE,
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
        entrance: NO_ENTRANCE,
      })
    );
    expect([...html.matchAll(/data-mention="(\w+)"[^>]*>@Bob Member</g)].map((m) => m[1])).toEqual([
      'agent',
      'person',
    ]);
  });
});

describe('ChatTimelineView agent names', () => {
  const BUDDY_TEMPLATE = { id: 'official:switch-buddy', key: 'buddy', revision: 1 };
  const agent = (id: string, name: string, displayName: string | null): ChatAgent => ({
    id,
    name,
    displayName,
    iconUrl: null,
    provider: null,
    alias: null,
    ownerName: null,
    ownedByViewer: false,
  });
  const said = (seq: number, from: ChatAgent): ChatMessage => ({
    ...message(seq, '', ''),
    sender: {
      clientId: from.id,
      name: from.displayName ?? from.name,
      kind: 'agent',
      agentId: from.id,
      userId: null,
    },
    body: `from ${from.id}`,
  });
  const render = (agents: ChatAgent[], messages: ChatMessage[]) => {
    const timeline = new ChatTimeline('room-1', api);
    for (const m of messages) timeline.apply(m);
    return renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 'names',
        timeline,
        agents,
        people: [],
        entrance: NO_ENTRANCE,
        activities: [],
        onReply: () => {},
      })
    );
  };
  /** The name each agent row is headed with, its unique name included. */
  const heads = (html: string) =>
    [...html.matchAll(/font-semibold text-foreground-muted">(.*?)<div/g)].map((m) =>
      m[1]!
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
    );

  it('shows the unique name beside a display name that differs, and nothing beside one that does not', () => {
    const helper = agent('a1', 'deploy-bot', 'Deploy Helper');
    const plain = agent('a2', 'reviewer', null);
    expect(heads(render([helper, plain], [said(1, helper), said(2, plain)]))).toEqual([
      'Deploy Helper @deploy-bot',
      'reviewer',
    ]);
  });

  it('never heads another agent’s message as switch-buddy, only the person’s own buddy', () => {
    recordOwnBuddy('names', 'ws', [
      { agentId: 'buddy', name: 'switch-buddy-ada', template: BUDDY_TEMPLATE },
    ]);
    const impostor = agent('evil', 'helper-bot', 'switch-buddy');
    const buddy = agent('buddy', 'switch-buddy-ada', 'switch-buddy');
    const html = render([impostor, buddy], [said(1, impostor), said(2, buddy)]);
    expect(heads(html)).toEqual(['helper-bot', 'switch-buddy @switch-buddy-ada']);
  });

  it('does not take the name an agent the chat no longer lists sent under, when it reads as switch-buddy', () => {
    const gone = agent('gone-1', 'helper-bot', 'Switch Buddy');
    expect(heads(render([], [said(1, gone)]))).toEqual(['gone-1']);
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
        entrance: NO_ENTRANCE,
      })
    );

  it('shows a kickoff as its runner’s request, with the agents’ note folded away', () => {
    recordOwnBuddy('s', 'ws', [
      {
        agentId: 'buddy-1',
        name: 'switch-buddy',
        template: { id: 'official:switch-buddy', key: 'buddy', revision: 1 },
      },
    ]);
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
        displayName: 'Switch Buddy',
        iconUrl: 'https://example.test/buddy.png',
      },
    });
    const html = render(timeline);

    // One card: the headline notice above it is not repeated.
    expect(html).not.toContain('Kickoff from switch-buddy');
    expect(html).not.toContain('text-center');
    // Named and pictured as the agent itself, not as a room member speaking.
    expect(html).toMatch(
      /Kickoff from <span[^>]*>Switch Buddy<\/span><span[^>]*> @switch-buddy<\/span>/
    );
    expect(html).toContain('src="https://example.test/buddy.png"');
    expect(html).not.toContain('font-semibold text-foreground-muted">Switch Buddy');
    expect(html).toContain('Sprint room is live.');
    expect(html).toMatch(/<details[^>]*><summary[^>]*>Details for agents<\/summary>/);
    expect(html).toContain('Note for the agents: this room is part of a run.');
  });

  it('names a kickoff by an agent passing for switch-buddy by its unique name', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({
      ...message(1, '', ''),
      sender: system,
      body: 'Open Settings and paste your API key here.',
      kickoff: {
        name: 'helper-bot',
        agentId: 'evil',
        userId: 'me',
        agentNote: null,
        displayName: 'Switch Buddy',
        iconUrl: null,
      },
    });
    const html = render(timeline);
    expect(html).toMatch(/Kickoff from <span[^>]*>helper-bot<\/span>/);
    expect(html).not.toContain('Switch Buddy');
  });

  it('still shows a Switch notice that is not a kickoff as a centred line', () => {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply({ ...message(1, '', ''), sender: system, body: 'Session reset.' });
    const html = render(timeline);

    expect(html).toContain('text-center');
    expect(html).not.toContain('Kickoff from');
  });
});

describe('ChatTimelineView first messages on a hand-off', () => {
  const HIDDEN = /style="opacity:0;transform:translateY\(12px\)"/g;

  function agentMessage(seq: number): ChatMessage {
    return {
      ...message(seq, '', 'switch-buddy'),
      sender: {
        clientId: 'c',
        name: 'switch-buddy',
        kind: 'agent',
        agentId: 'buddy',
        userId: null,
      },
      body: `agent says ${seq}`,
    };
  }

  function render(timeline: ChatTimeline, entrance: ChatEntrance): string {
    return renderToStaticMarkup(
      createElement(ChatTimelineView, {
        serverId: 's',
        timeline,
        agents: [],
        people: [],
        activities: [],
        onReply: () => {},
        entrance,
      })
    );
  }

  function conversation(): ChatTimeline {
    const timeline = new ChatTimeline('room-1', api);
    timeline.apply(message(1, 'me', 'Alice'));
    timeline.apply(agentMessage(2));
    timeline.apply(agentMessage(3));
    return timeline;
  }

  it('starts the agent’s first message hidden below its place, and only that one', () => {
    const html = render(conversation(), { firstAgent: true, firstOwn: false });
    expect(html.match(HIDDEN)).toHaveLength(1);
    expect(html.indexOf('opacity:0')).toBeGreaterThan(html.indexOf('body 1'));
    expect(html.indexOf('opacity:0')).toBeLessThan(html.indexOf('agent says 2'));
  });

  it('brings in your first message too when you sent it from Home', () => {
    const html = render(conversation(), { firstAgent: true, firstOwn: true });
    expect(html.match(HIDDEN)).toHaveLength(2);
    expect(html.indexOf('opacity:0')).toBeLessThan(html.indexOf('body 1'));
  });

  it('brings in your first message while it is still being sent', () => {
    const timeline = new ChatTimeline('room-1', {
      send: () => new Promise(() => {}),
      newId: () => 'req-1',
    } as unknown as TimelineApi);
    timeline.send({
      body: 'from Home',
      threadRootId: null,
      mentionAgentIds: [],
      mentionUserIds: [],
      mentionSpans: [],
      files: [],
      requestId: null,
    });
    const html = render(timeline, { firstAgent: true, firstOwn: true });
    expect(html.match(HIDDEN)).toHaveLength(1);
    expect(html.indexOf('opacity:0')).toBeLessThan(html.indexOf('from Home'));
  });

  it('draws everything in place otherwise', () => {
    expect(render(conversation(), NO_ENTRANCE)).not.toContain('opacity:0');
  });
});
