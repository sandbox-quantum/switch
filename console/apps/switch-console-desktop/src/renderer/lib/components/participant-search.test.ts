import { describe, expect, it } from 'vitest';
import {
  agentParticipant,
  type Participant,
  personParticipant,
  pickerKey,
  searchParticipants,
} from './participant-search';

const helper: Participant = {
  kind: 'agent',
  id: 'a1',
  name: 'helper',
  iconUrl: null,
  detail: 'Agent · Claude Code',
};
const reviewer: Participant = { ...helper, id: 'a2', name: 'reviewer', detail: 'Agent · Codex' };
const bob: Participant = { kind: 'person', id: 'u2', name: 'Bob', detail: 'bob@example.com' };
// The same id as an agent must not hide a person.
const sameId: Participant = { kind: 'person', id: 'a1', name: 'Ada', detail: 'ada@example.com' };
const all = [helper, reviewer, bob, sameId];

describe('searchParticipants', () => {
  it('finds agents and people together, by name, provider or email', () => {
    expect(searchParticipants(all, [], '')).toEqual(all);
    expect(searchParticipants(all, [], 'B')).toEqual([bob]);
    expect(searchParticipants(all, [], 'codex')).toEqual([reviewer]);
    expect(searchParticipants(all, [], 'example.com')).toEqual([bob, sameId]);
  });

  it('leaves out who is already picked', () => {
    expect(searchParticipants(all, [helper, bob], '')).toEqual([reviewer, sameId]);
  });
});

describe('pickerKey', () => {
  const state = { query: '', open: true, active: 0, results: 3, picked: 2 };

  it('moves through the results, wrapping', () => {
    expect(pickerKey('ArrowDown', state)).toEqual({ type: 'move', active: 1 });
    expect(pickerKey('ArrowDown', { ...state, active: 2 })).toEqual({ type: 'move', active: 0 });
    expect(pickerKey('ArrowUp', state)).toEqual({ type: 'move', active: 2 });
    expect(pickerKey('ArrowDown', { ...state, results: 0 })).toBeNull();
  });

  it('adds with Enter only from an open list with results', () => {
    expect(pickerKey('Enter', state)).toEqual({ type: 'add' });
    expect(pickerKey('Enter', { ...state, open: false })).toBeNull();
    expect(pickerKey('Enter', { ...state, results: 0 })).toBeNull();
  });

  it('takes back the last chip with Backspace on an empty field only', () => {
    expect(pickerKey('Backspace', state)).toEqual({ type: 'removeLast' });
    expect(pickerKey('Backspace', { ...state, query: 'b' })).toBeNull();
    expect(pickerKey('Backspace', { ...state, picked: 0 })).toBeNull();
  });

  it('closes the list with Escape, and leaves Escape to the dialog once closed', () => {
    expect(pickerKey('Escape', state)).toEqual({ type: 'close' });
    expect(pickerKey('Escape', { ...state, open: false })).toBeNull();
  });
});

describe('agentParticipant / personParticipant', () => {
  it('shows an agent by its display name and provider, a person by their email', () => {
    expect(
      agentParticipant({ id: 'a1', name: 'helper', displayName: 'Helper', iconUrl: null }, 'Codex')
    ).toEqual({ kind: 'agent', id: 'a1', name: 'Helper', iconUrl: null, detail: 'Agent · Codex' });
    expect(personParticipant({ userId: 'u2', name: 'Bob', email: null })).toEqual({
      kind: 'person',
      id: 'u2',
      name: 'Bob',
      detail: '',
    });
  });
});
