import type { RoomVisibility } from '@shared/core/switch-servers/switch-servers';

/**
 * What someone may do with a room. `canManage` is the owner's and the
 * workspace admins' alone: deleting the room, changing who may see it, naming
 * it after its channel. `canWrite` also covers anyone at all when the room's
 * write access is public: its description and instructions, who is in it, its
 * roles, its group, archiving it.
 */
export type RoomPermissions = { canWrite: boolean; canManage: boolean };

/**
 * What one viewer may do with a room: the server's own answer when it gives
 * one, otherwise the gateway's room rule (`authz.can`) worked out here. A room
 * whose write access is not known — a server that predates the setting — is
 * treated as public, which is what every room was before it existed.
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
  if (viewer.userId === null) return { canWrite: false, canManage: false };
  const canManage = viewer.isAdmin || (room.ownerId !== null && room.ownerId === viewer.userId);
  const canWrite = canManage || (room.writeVisibility ?? 'public') === 'public';
  return { canWrite, canManage };
}
