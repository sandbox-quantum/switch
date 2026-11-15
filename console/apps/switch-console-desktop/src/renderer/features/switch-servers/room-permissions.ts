import type { RoomVisibility } from '@shared/core/switch-servers/switch-servers';

/**
 * What someone may do with a room, as the server's room policy decides it.
 * `canManage` (the room's owner or a workspace admin): deleting the room,
 * changing who may see it, naming it after its channel. `canManageAdmins`
 * (the same): choosing its room admins. `canWrite` (the owner, a room admin
 * or a workspace admin, on a current server): its description and
 * instructions, its roles, its group. `canArchive` (the same): archiving it.
 * `canInviteAgents`, `canAddPeople` and `canAttach` (anyone in the room):
 * bringing agents in, adding people, attaching resources; each agent's own
 * "who can address me" setting can still refuse one. `canRemoveMembers`
 * (owner, room admin or workspace admin): taking agents out. No membership
 * flag is set in a direct or group conversation, whose platform fixes who is
 * in it. `canUnlink` (owner, room admin or workspace admin): detaching what
 * is attached to it. `canChangeMembers` is what an older server said for
 * adding and removing together.
 */
export type RoomPermissions = {
  canWrite: boolean;
  canChangeMembers: boolean;
  canInviteAgents: boolean;
  canAddPeople: boolean;
  canAttach: boolean;
  canRemoveMembers: boolean;
  canManage: boolean;
  canArchive: boolean;
  canManageAdmins: boolean;
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
    return {
      canWrite: false,
      canChangeMembers: false,
      canInviteAgents: false,
      canAddPeople: false,
      canAttach: false,
      canRemoveMembers: false,
      canManage: false,
      canArchive: false,
      canManageAdmins: false,
      canUnlink: false,
    };
  }
  const canManage = viewer.isAdmin || (room.ownerId !== null && room.ownerId === viewer.userId);
  const canWrite = canManage || room.writeVisibility === 'public';
  return {
    canWrite,
    canChangeMembers: canWrite,
    canInviteAgents: canWrite,
    canAddPeople: canWrite,
    canAttach: canWrite,
    canRemoveMembers: canWrite,
    canManage,
    canArchive: canManage,
    // A server that does not send its flags predates room admins.
    canManageAdmins: false,
    canUnlink: canWrite,
  };
}
