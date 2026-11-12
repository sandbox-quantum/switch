import type { RoomVisibility } from '@shared/core/switch-servers/switch-servers';

/**
 * What someone may do with a room. `canManage` is the owner's and the
 * workspace admins' alone: deleting the room, changing who may see it, naming
 * it after its channel. `canWrite` also covers anyone at all when the room's
 * write access is public: its description and instructions, its roles, its
 * group, archiving it. `canChangeMembers` is adding and removing its agents
 * and people: `canWrite`, except in a direct or group conversation, whose
 * platform fixes who is in it. `canUnlink` is detaching what is attached to
 * it: the server now keeps that for those taking part in the room and
 * workspace admins, whatever its write access.
 */
export type RoomPermissions = {
  canWrite: boolean;
  canChangeMembers: boolean;
  canManage: boolean;
  canUnlink: boolean;
};

/**
 * What one viewer may do with a room: the server's own answer when it gives
 * one, otherwise the gateway's room rule (`authz.can`) worked out here, where
 * detaching takes write access as it did before the server said otherwise.
 * A room whose write access is not known offers no writing beyond its owner's
 * and admins': showing a control the server then refuses is the worse
 * mistake.
 */
export function roomPermissionsFor(
  room: {
    ownerId: string | null;
    writeVisibility?: RoomVisibility;
    serverPermissions?: RoomPermissions;
  },
  viewer: { userId: string | null; isAdmin: boolean }
): RoomPermissions {
  if (room.serverPermissions) return room.serverPermissions;
  if (viewer.userId === null) {
    return { canWrite: false, canChangeMembers: false, canManage: false, canUnlink: false };
  }
  const canManage = viewer.isAdmin || (room.ownerId !== null && room.ownerId === viewer.userId);
  const canWrite = canManage || room.writeVisibility === 'public';
  return { canWrite, canChangeMembers: canWrite, canManage, canUnlink: canWrite };
}
