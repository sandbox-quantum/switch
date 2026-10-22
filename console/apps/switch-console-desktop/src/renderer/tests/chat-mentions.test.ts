import { describe, expect, it } from 'vitest';
import {
  filterMentionAgents,
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
    expect(mentionTokens(text, agents)).toEqual([
      { agentId: 'a2', start: 3, end: 13 },
      { agentId: 'a2', start: 18, end: 27 },
      { agentId: 'a1', start: 29, end: 39 },
    ]);
  });

  it('prefers the longest name and never matches inside a longer word', () => {
    expect(mentionTokens('@cc-2 @cc @cc-3 bob@cc', agents).map((t) => t.agentId)).toEqual([
      'a4',
      'a3',
    ]);
  });

  it('drops a mention once an edit lands inside it, or its agent leaves', () => {
    expect(mentionTokens('@agent-tXwo hi', agents)).toEqual([]);
    expect(mentionTokens('@agent-twos hi', agents)).toEqual([]);
    expect(mentionTokens('@agent-two hi', agents.slice(0, 1))).toEqual([]);
  });

  it('addresses an agent once however often it is mentioned', () => {
    expect(mentionAgentIds(mentionTokens('@agent-two @reviewer @agent-two', agents))).toEqual([
      'a2',
    ]);
  });

  it('splits text into plain and mention runs', () => {
    const text = 'x @cc y';
    expect(mentionSegments(text, mentionTokens(text, agents))).toEqual([
      { text: 'x ', agentId: null },
      { text: '@cc', agentId: 'a3' },
      { text: ' y', agentId: null },
    ]);
  });
});

describe('mention editing', () => {
  const text = 'a @agent-two b';
  const tokens = mentionTokens(text, agents);

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
