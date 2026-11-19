import { describe, expect, it } from 'vitest';
import { roomAdminAction, roomAdminStandingOf } from './room-admins';

const ROOM = {
  roomAdmins: [
    { userId: 'u-ada', name: 'Ada Lovelace', grantedBy: 'u-1', grantedAt: '2026-11-01' },
  ],
  roomAdminCandidates: [
    { userId: 'u-bob', name: 'Bob' },
    { userId: 'u-bo1', name: 'Bo' },
    { userId: 'u-bo2', name: 'Bo' },
  ],
};

describe('roomAdminStandingOf', () => {
  it('matches a username by who linked it', () => {
    expect(
      roomAdminStandingOf(ROOM, { name: 'ada', fullName: 'Ada L.', userIds: ['u-ada'] })
    ).toEqual({ userId: 'u-ada', name: 'Ada Lovelace', isAdmin: true });
  });

  it('falls back to the Switch name that linked the username', () => {
    expect(
      roomAdminStandingOf(ROOM, { name: 'ada', fullName: 'Ada Lovelace', userIds: [] })?.userId
    ).toBe('u-ada');
  });

  it('never takes an unlinked username for a Switch user of that name', () => {
    expect(roomAdminStandingOf(ROOM, { name: 'Bob', fullName: null, userIds: [] })).toBeNull();
  });

  it('says nothing when the name is shared, or nobody has it', () => {
    expect(roomAdminStandingOf(ROOM, { name: 'x', fullName: 'Bo', userIds: [] })).toBeNull();
    expect(roomAdminStandingOf(ROOM, { name: 'carol', fullName: null, userIds: [] })).toBeNull();
  });

  it('knows nobody on a server that predates room admins', () => {
    expect(
      roomAdminStandingOf(
        { roomAdmins: [], roomAdminCandidates: [] },
        { name: 'ada', fullName: null, userIds: ['u-ada'] }
      )
    ).toBeNull();
  });
});

describe('roomAdminAction', () => {
  const ada = { userId: 'u-ada', name: 'Ada', isAdmin: true };
  const bob = { userId: 'u-bob', name: 'Bob', isAdmin: false };
  const owner = { userId: 'u-1', canManageAdmins: true };

  it('lets the owner or a workspace admin choose room admins', () => {
    expect(roomAdminAction(bob, owner)).toMatchObject({ admin: true, label: 'Make room admin' });
    expect(roomAdminAction(ada, owner)).toMatchObject({ admin: false, label: 'Remove room admin' });
  });

  it('lets a room admin step down, and nothing else', () => {
    const viewer = { userId: 'u-ada', canManageAdmins: false };
    expect(roomAdminAction(ada, viewer)).toMatchObject({
      admin: false,
      label: 'Step down as room admin',
    });
    expect(roomAdminAction(bob, viewer)).toBeNull();
    expect(roomAdminAction({ ...bob, isAdmin: true }, viewer)).toBeNull();
  });
});
