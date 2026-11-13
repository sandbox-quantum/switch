import { describe, expect, it } from 'vitest';
import type { StoredTemplateSummary } from '@main/core/switch-servers/gateway-client';
import { kindOf, matchesFilter, scopeCounts, toggleKind } from './template-filters';

function template(overrides: Partial<StoredTemplateSummary>): StoredTemplateSummary {
  return {
    id: 't',
    name: 'Feature room',
    description: 'Build software features',
    kind: 'room',
    creator: 'Ada',
    ownerId: 'ada',
    official: false,
    version: 1,
    readVisibility: 'public',
    writeVisibility: 'private',
    canEdit: null,
    canManage: null,
    ...overrides,
  };
}

const official = template({ id: 'o', official: true, ownerId: null, creator: 'Switch' });
const mine = template({ id: 'm', ownerId: 'me', creator: 'Me', kind: 'agent' });
const theirs = template({ id: 'x', ownerId: 'ada', kind: 'group', name: 'Product org' });
const all = [official, mine, theirs];

const filter = { scope: 'all', kinds: [], query: '', meId: 'me' } as const;

describe('scopeCounts', () => {
  it('splits All into Official and Workspace, with Yours inside Workspace', () => {
    expect(scopeCounts(all, 'me')).toEqual({ all: 3, official: 1, workspace: 2, yours: 1 });
  });

  it('counts nothing as yours with nobody signed in', () => {
    expect(scopeCounts(all, null).yours).toBe(0);
  });
});

describe('matchesFilter', () => {
  it('keeps every template on All with no kind or search', () => {
    expect(all.filter((t) => matchesFilter(t, filter))).toEqual(all);
  });

  it('keeps only the scope the tab names', () => {
    expect(all.filter((t) => matchesFilter(t, { ...filter, scope: 'official' }))).toEqual([
      official,
    ]);
    expect(all.filter((t) => matchesFilter(t, { ...filter, scope: 'yours' }))).toEqual([mine]);
  });

  it('keeps any of the chosen kinds', () => {
    const kinds = ['agent', 'group'] as const;
    expect(all.filter((t) => matchesFilter(t, { ...filter, kinds }))).toEqual([mine, theirs]);
  });

  it('searches name, description and author, ignoring case', () => {
    expect(matchesFilter(theirs, { ...filter, query: 'PRODUCT' })).toBe(true);
    expect(matchesFilter(theirs, { ...filter, query: 'software' })).toBe(true);
    expect(matchesFilter(theirs, { ...filter, query: 'ada' })).toBe(true);
    expect(matchesFilter(theirs, { ...filter, query: 'video' })).toBe(false);
  });
});

describe('kindOf', () => {
  it('reads an unknown kind as a room', () => {
    expect(kindOf('workflow')).toBe('room');
    expect(kindOf('agent')).toBe('agent');
  });
});

describe('toggleKind', () => {
  it('adds a kind that is out and removes one that is in', () => {
    expect(toggleKind(['room'], 'agent')).toEqual(['room', 'agent']);
    expect(toggleKind(['room', 'agent'], 'room')).toEqual(['agent']);
  });
});
