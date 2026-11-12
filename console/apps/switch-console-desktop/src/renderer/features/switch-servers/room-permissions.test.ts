import { describe, expect, it } from 'vitest';
import { roomPermissionsFor } from './room-permissions';

const ME = { userId: 'u-1', isAdmin: false };

describe('roomPermissionsFor', () => {
  it('lets the owner manage, write and detach', () => {
    expect(roomPermissionsFor({ ownerId: 'u-1', writeVisibility: 'private' }, ME)).toEqual({
      canWrite: true,
      canChangeMembers: true,
      canManage: true,
      canUnlink: true,
    });
  });

  it('lets an admin manage someone else’s private room', () => {
    expect(
      roomPermissionsFor(
        { ownerId: 'u-2', writeVisibility: 'private' },
        { userId: 'u-1', isAdmin: true }
      )
    ).toEqual({ canWrite: true, canChangeMembers: true, canManage: true, canUnlink: true });
  });

  it('lets anyone write to a publicly writable room, but not manage it', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2', writeVisibility: 'public' }, ME)).toEqual({
      canWrite: true,
      canChangeMembers: true,
      canManage: false,
      canUnlink: true,
    });
  });

  it('gives a non-owner nothing on a privately writable room', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2', writeVisibility: 'private' }, ME)).toEqual({
      canWrite: false,
      canChangeMembers: false,
      canManage: false,
      canUnlink: false,
    });
  });

  it('treats a room with no owner as nobody’s to manage', () => {
    expect(roomPermissionsFor({ ownerId: null, writeVisibility: 'private' }, ME).canManage).toBe(
      false
    );
  });

  it('offers no writing on a room whose write access is not known, so nothing it shows is refused', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2' }, ME)).toEqual({
      canWrite: false,
      canChangeMembers: false,
      canManage: false,
      canUnlink: false,
    });
    expect(roomPermissionsFor({ ownerId: 'u-1' }, ME).canWrite).toBe(true);
  });

  it('takes the server’s answer over its own working when the server gives one', () => {
    // A direct conversation: written to, but who is in it is its platform's.
    const answer = { canWrite: true, canChangeMembers: false, canManage: false, canUnlink: false };
    expect(
      roomPermissionsFor(
        { ownerId: 'u-1', writeVisibility: 'public', serverPermissions: answer },
        ME
      )
    ).toEqual(answer);
  });

  it('gives an unknown viewer nothing', () => {
    expect(
      roomPermissionsFor(
        { ownerId: 'u-1', writeVisibility: 'public' },
        { userId: null, isAdmin: true }
      )
    ).toEqual({ canWrite: false, canChangeMembers: false, canManage: false, canUnlink: false });
  });
});
