import { describe, expect, it } from 'vitest';
import {
  addableAgents,
  addableBridgePeople,
  addablePeople,
  linkedNamesByUsername,
  membershipSummary,
  roomTitle,
} from './room-labels';

describe('roomTitle', () => {
  it('marks a bridged room as the channel it is', () => {
    expect(roomTitle({ name: 'louis-dev', bridgeType: 'mattermost' })).toBe('#louis-dev');
  });

  it('leaves a room in no messaging app alone — there is no channel to name', () => {
    expect(roomTitle({ name: 'louis-dev', bridgeType: null })).toBe('louis-dev');
  });

  it('does not double the sigil on a name that already carries one', () => {
    expect(roomTitle({ name: '#general', bridgeType: 'slack' })).toBe('#general');
  });
});

describe('membershipSummary', () => {
  it('counts agents and people separately', () => {
    expect(membershipSummary(1, 1)).toBe('1 agent · 1 person');
    expect(membershipSummary(3, 2)).toBe('3 agents · 2 people');
  });

  it('omits people rather than reporting none', () => {
    expect(membershipSummary(2, 0)).toBe('2 agents');
  });

  it('says an empty room has no agents rather than saying nothing', () => {
    expect(membershipSummary(0, 0)).toBe('0 agents');
  });
});

describe('addablePeople', () => {
  it('skips a service account by its flag and anyone already in, not by name', () => {
    const roster = [
      { userId: 'u1', name: 'Agent Bootstrap', serviceAccount: true },
      { userId: 'u2', name: 'Agent Bootstrap', serviceAccount: false },
      { userId: 'u3', name: 'alice', serviceAccount: false },
    ];
    expect(addablePeople(roster, new Set(['u3'])).map((person) => person.userId)).toEqual(['u2']);
  });
});

describe('addableAgents', () => {
  it('offers only the agents the server names as candidates', () => {
    expect(addableAgents([{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }], ['a2', 'gone'])).toEqual([
      { id: 'a2' },
    ]);
  });
});

describe('addableBridgePeople', () => {
  const person = (username: string, linkedName: string | null) => ({
    username,
    externalUserId: `U-${username}`,
    linkedUserIds: linkedName ? [`id-${username}`] : [],
    linkedName,
  });

  it('shows a linked person by their full name, with the username beside it', () => {
    expect(addableBridgePeople([person('simon.flack', 'Simon Flack')], new Set())).toEqual([
      { id: 'simon.flack', name: 'Simon Flack', detail: '@simon.flack' },
    ]);
  });

  it('shows someone nobody has linked by their username, as there is no name for them', () => {
    expect(addableBridgePeople([person('ada', null)], new Set())).toEqual([
      { id: 'ada', name: 'ada', detail: '@ada' },
    ]);
  });

  it('leaves out who is already in the room, by username', () => {
    const people = [person('ada', 'Ada Lovelace'), person('bob', null)];
    expect(addableBridgePeople(people, new Set(['ada'])).map((row) => row.id)).toEqual(['bob']);
  });

  it('offers a username seen under two accounts once, keeping the name either gave', () => {
    const people = [
      person('carol', null),
      { ...person('carol', 'Carol Shaw'), externalUserId: 'U-2' },
    ];
    expect(addableBridgePeople(people, new Set())).toEqual([
      { id: 'carol', name: 'Carol Shaw', detail: '@carol' },
    ]);
  });

  it('sorts by the name shown', () => {
    const people = [person('zed', 'Ada Zed'), person('bea', null)];
    expect(addableBridgePeople(people, new Set()).map((row) => row.name)).toEqual([
      'Ada Zed',
      'bea',
    ]);
  });
});

describe('linkedNamesByUsername', () => {
  const person = (username: string, linkedName: string | null) => ({
    username,
    externalUserId: `U-${username}-${linkedName}`,
    linkedUserIds: linkedName ? ['u'] : [],
    linkedName,
  });

  it('names each linked username, and leaves out one nobody linked', () => {
    const names = linkedNamesByUsername([person('ada', 'Ada Lovelace'), person('bob', null)]);
    expect([...names]).toEqual([['ada', 'Ada Lovelace']]);
  });

  it('keeps the first name found for a username seen twice', () => {
    const names = linkedNamesByUsername([
      person('carol', null),
      person('carol', 'Carol Shaw'),
      person('carol', 'C. Shaw'),
    ]);
    expect(names.get('carol')).toBe('Carol Shaw');
  });
});
