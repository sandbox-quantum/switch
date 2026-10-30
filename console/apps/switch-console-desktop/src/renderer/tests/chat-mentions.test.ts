import { describe, expect, it } from 'vitest';
import {
  agentTargets,
  composeMentions,
  editMentions,
  mentionSpans,
  tokensFromSpans,
  withoutGroupMentions,
  mentionPayload,
  shiftMentions,
  filterMentionAgents,
  filterMentionPeople,
  mentionUserIds,
  personTargets,
  mentionAgentIds,
  mentionQuery,
  mentionSegments,
  mentionTokens,
  tokenToRemove,
} from '@renderer/features/chats/mentions';

const agents = [
  { id: 'a1', name: 'agent-one', alias: null },
  { id: 'a2', name: 'agent-two', alias: 'reviewer' },
  { id: 'a3', name: 'cc', alias: null },
  { id: 'a4', name: 'cc-2', alias: null },
];

describe('mentionTokens', () => {
  it('finds whole @name and @alias mentions, case-insensitively', () => {
    const text = 'hi @Agent-Two and @reviewer, @agent-one!';
    expect(mentionTokens(text, agentTargets(agents))).toEqual([
      { kind: 'agent', id: 'a2', start: 3, end: 13 },
      { kind: 'agent', id: 'a2', start: 18, end: 27 },
      { kind: 'agent', id: 'a1', start: 29, end: 39 },
    ]);
  });

  it('prefers the longest name and never matches inside a longer word', () => {
    expect(mentionTokens('@cc-2 @cc @cc-3 bob@cc', agentTargets(agents)).map((t) => t.id)).toEqual([
      'a4',
      'a3',
    ]);
  });

  it('drops a mention once an edit lands inside it, or its agent leaves', () => {
    expect(mentionTokens('@agent-tXwo hi', agentTargets(agents))).toEqual([]);
    expect(mentionTokens('@agent-twos hi', agentTargets(agents))).toEqual([]);
    expect(mentionTokens('@agent-two hi', agentTargets(agents.slice(0, 1)))).toEqual([]);
  });

  it('addresses an agent once however often it is mentioned', () => {
    expect(
      mentionAgentIds(mentionTokens('@agent-two @reviewer @agent-two', agentTargets(agents)))
    ).toEqual(['a2']);
  });

  it('splits text into plain and mention runs', () => {
    const text = 'x @cc y';
    expect(mentionSegments(text, mentionTokens(text, agentTargets(agents)))).toEqual([
      { text: 'x ', token: null },
      { text: '@cc', token: { kind: 'agent', id: 'a3', start: 2, end: 5 } },
      { text: ' y', token: null },
    ]);
  });
});

describe('mention editing', () => {
  const text = 'a @agent-two b';
  const tokens = mentionTokens(text, agentTargets(agents));

  it('removes a whole mention on Backspace at its end or inside it', () => {
    expect(tokenToRemove(tokens, 12, 'Backspace')).toEqual(tokens[0]);
    expect(tokenToRemove(tokens, 5, 'Backspace')).toEqual(tokens[0]);
    expect(tokenToRemove(tokens, 2, 'Backspace')).toBeNull();
    expect(tokenToRemove(tokens, 13, 'Backspace')).toBeNull();
  });

  it('removes a whole mention on Delete at its start', () => {
    expect(tokenToRemove(tokens, 2, 'Delete')).toEqual(tokens[0]);
    expect(tokenToRemove(tokens, 12, 'Delete')).toBeNull();
  });
});

describe('mention suggestions', () => {
  it('opens on @ at the start or after whitespace only', () => {
    expect(mentionQuery('@ag', 3)).toEqual({ start: 0, query: 'ag' });
    expect(mentionQuery('hi\n@', 4)).toEqual({ start: 3, query: '' });
    expect(mentionQuery('bob@ag', 6)).toBeNull();
    expect(mentionQuery('@ag x', 5)).toBeNull();
  });

  it('filters by name and alias, prefix matches first', () => {
    expect(filterMentionAgents(agents, 'TWO').map((a) => a.id)).toEqual(['a2']);
    expect(filterMentionAgents(agents, 'rev').map((a) => a.id)).toEqual(['a2']);
    const named = [
      { id: 'x', name: 'bob-ann', alias: null },
      { id: 'y', name: 'ann', alias: null },
    ];
    expect(filterMentionAgents(named, 'ann').map((a) => a.id)).toEqual(['y', 'x']);
  });
});

describe('people mentions', () => {
  const people = [
    { userId: 'u1', name: 'Bob Member' },
    { userId: 'u2', name: 'cc' },
  ];

  it('matches a whole display name with spaces, and sends people apart from agents', () => {
    const text = 'hi @Bob Member, ask @agent-one';
    const tokens = mentionTokens(text, [...agentTargets(agents), ...personTargets(people)]);
    expect(tokens).toEqual([
      { kind: 'person', id: 'u1', start: 3, end: 14 },
      { kind: 'agent', id: 'a1', start: 20, end: 30 },
    ]);
    expect(mentionAgentIds(tokens)).toEqual(['a1']);
    expect(mentionUserIds(tokens)).toEqual(['u1']);
    expect(mentionTokens('@Bob Memberx', personTargets(people))).toEqual([]);
  });

  it('reads a name shared by a person and an agent as whichever is listed first', () => {
    const asPerson = mentionTokens('@cc', [...personTargets(people), ...agentTargets(agents)]);
    expect(asPerson).toEqual([{ kind: 'person', id: 'u2', start: 0, end: 3 }]);
    // A person-only mention addresses no agent.
    expect(mentionAgentIds(asPerson)).toEqual([]);
    expect(mentionTokens('@cc', [...agentTargets(agents), ...personTargets(people)])[0]!.kind).toBe(
      'agent'
    );
  });

  it('suggests people whose name contains the query, those it starts first', () => {
    expect(filterMentionPeople(people, 'm').map((p) => p.userId)).toEqual(['u1']);
    expect(filterMentionPeople(people, '').map((p) => p.userId)).toEqual(['u1', 'u2']);
  });
});

describe('picked mentions', () => {
  const sharer = [{ id: 'a9', name: 'Bob Member', alias: null }];
  const bob = [{ userId: 'u1', name: 'Bob Member' }];
  const targets = [...agentTargets(sharer), ...personTargets(bob)];

  it('keeps who a picked mention names across a saved and restored draft', () => {
    const text = 'hi @Bob Member';
    const saved = { text, mentions: [{ kind: 'person' as const, id: 'u1', start: 3, end: 14 }] };
    const restored = composeMentions(saved.text, saved.mentions, targets);
    expect(restored).toEqual([{ kind: 'person', id: 'u1', start: 3, end: 14 }]);
    // Unpicked, the same text reads as the agent.
    expect(composeMentions(text, [], targets)[0]!.kind).toBe('agent');
  });

  it('addresses the agent and the person of one name, one each', () => {
    const text = '@Bob Member and @Bob Member';
    const tokens = composeMentions(
      text,
      [
        { kind: 'agent', id: 'a9', start: 0, end: 11 },
        { kind: 'person', id: 'u1', start: 16, end: 27 },
      ],
      targets
    );
    expect(mentionAgentIds(tokens)).toEqual(['a9']);
    expect(mentionUserIds(tokens)).toEqual(['u1']);
  });

  it('moves picked mentions with an edit before them and drops one an edit lands in', () => {
    const mention = { kind: 'person' as const, id: 'u1', start: 3, end: 14 };
    expect(shiftMentions('hi @Bob Member', 'oh hi @Bob Member', [mention])).toEqual([
      { ...mention, start: 6, end: 17 },
    ]);
    expect(shiftMentions('hi @Bob Member', 'hi @Bob XMember', [mention])).toEqual([]);
    expect(composeMentions('hi @Bob', [mention], targets)).toEqual([]);
  });
});

describe('undoing the removal of a picked mention', () => {
  const sharer = [{ id: 'a9', name: 'Bob Member', alias: null }];
  const bob = [{ userId: 'u1', name: 'Bob Member' }];
  const targets = [...agentTargets(sharer), ...personTargets(bob)];
  const person = { kind: 'person' as const, id: 'u1', start: 3, end: 14 };

  it('brings the mention back as the person on undo, and not on a plain retype', () => {
    const removed = editMentions('hi @Bob Member', 'hi ', [person], [], false);
    expect(removed.mentions).toEqual([]);
    const retyped = editMentions('hi ', 'hi @Bob Member', [], removed.remembered, false);
    expect(retyped.mentions).toEqual([]);
    const undone = editMentions('hi ', 'hi @Bob Member', [], removed.remembered, true);
    expect(undone.mentions).toEqual([person]);
    expect(undone.remembered).toEqual([]);
    expect(composeMentions('hi @Bob Member', undone.mentions, targets)[0]!.kind).toBe('person');
  });
});

describe('mention spans', () => {
  it('counts offsets in UTF-16 code units, so an emoji before a mention moves it by two', () => {
    const body = '🎉 @Bob Member';
    const tokens = [{ kind: 'person' as const, id: 'u1', start: 3, end: 14 }];
    expect(body.slice(3, 14)).toBe('@Bob Member');
    expect(mentionSpans(tokens)).toEqual([{ kind: 'user', id: 'u1', offset: 3, length: 11 }]);
    expect(tokensFromSpans(body, mentionSpans(tokens))).toEqual(tokens);
    expect(tokensFromSpans(body, [{ kind: 'agent', id: 'a1', offset: 10, length: 20 }])).toEqual(
      []
    );
  });
});

describe('withoutGroupMentions', () => {
  it('keeps the first agent mention only', () => {
    expect(
      withoutGroupMentions([
        { kind: 'person', id: 'u1', start: 0, end: 4 },
        { kind: 'agent', id: 'a1', start: 5, end: 9 },
        { kind: 'agent', id: 'a2', start: 10, end: 14 },
      ])
    ).toEqual([{ kind: 'agent', id: 'a1', start: 5, end: 9 }]);
  });
});

describe('mentionPayload', () => {
  const tokens = [
    { kind: 'agent' as const, id: 'a1', start: 0, end: 10 },
    { kind: 'person' as const, id: 'u1', start: 11, end: 22 },
  ];

  it('sends only the agents without group chats', () => {
    expect(mentionPayload(tokens, false)).toEqual({
      mentionAgentIds: ['a1'],
      mentionUserIds: [],
      mentionSpans: [],
    });
  });

  it('sends people and spans with group chats', () => {
    expect(mentionPayload(tokens, true)).toEqual({
      mentionAgentIds: ['a1'],
      mentionUserIds: ['u1'],
      mentionSpans: [
        { kind: 'agent', id: 'a1', offset: 0, length: 10 },
        { kind: 'user', id: 'u1', offset: 11, length: 11 },
      ],
    });
  });
});
