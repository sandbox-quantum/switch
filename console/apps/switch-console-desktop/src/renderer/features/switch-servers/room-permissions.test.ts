import { describe, expect, it } from 'vitest';
import { roomPermissionsFor } from './room-permissions';

const ME = { userId: 'u-1', isAdmin: false };

describe('roomPermissionsFor', () => {
  it('lets the owner manage and write', () => {
    expect(roomPermissionsFor({ ownerId: 'u-1', writeVisibility: 'private' }, ME)).toEqual({
      canWrite: true,
      canManage: true,
    });
  });

  it('lets an admin manage someone else’s private room', () => {
    expect(
      roomPermissionsFor(
        { ownerId: 'u-2', writeVisibility: 'private' },
        { userId: 'u-1', isAdmin: true }
      )
    ).toEqual({ canWrite: true, canManage: true });
  });

  it('lets anyone write to a publicly writable room, but not manage it', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2', writeVisibility: 'public' }, ME)).toEqual({
      canWrite: true,
      canManage: false,
    });
  });

  it('gives a non-owner nothing on a privately writable room', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2', writeVisibility: 'private' }, ME)).toEqual({
      canWrite: false,
      canManage: false,
    });
  });

  it('treats a room with no owner as nobody’s to manage', () => {
    expect(roomPermissionsFor({ ownerId: null, writeVisibility: 'private' }, ME).canManage).toBe(
      false
    );
  });

  it('reads an unknown write access as public, as rooms were before the setting', () => {
    expect(roomPermissionsFor({ ownerId: 'u-2' }, ME).canWrite).toBe(true);
  });

  it('gives an unknown viewer nothing', () => {
    expect(
      roomPermissionsFor(
        { ownerId: 'u-1', writeVisibility: 'public' },
        { userId: null, isAdmin: true }
      )
    ).toEqual({ canWrite: false, canManage: false });
  });
});
