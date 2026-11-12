import type { RemoteRoomDetail } from '@shared/core/switch-servers/switch-servers';

/** One person on a room's people list, as far as Switch can tell who they are. */
export type RoomPersonIdentity = {
  name: string;
  /** For a messaging-app username, the name of the Switch user who linked it. */
  fullName: string | null;
  /** The Switch users who linked the username, when known. */
  userIds: string[];
};

/** A person in the room who is a room admin, or could be made one. */
export type RoomAdminStanding = { userId: string; name: string; isAdmin: boolean };

/**
 * Which Switch user a person on the room's people list is, among its room
 * admins and those who could be made one; null when they are neither, or when
 * it cannot be told. A bridged room lists people by their messaging-app
 * username, so who linked it decides; failing that, the Switch name, matched
 * only when one person has it.
 */
export function roomAdminStandingOf(
  room: Pick<RemoteRoomDetail, 'roomAdmins' | 'roomAdminCandidates'>,
  person: RoomPersonIdentity
): RoomAdminStanding | null {
  const known = [
    ...room.roomAdmins.map((a) => ({ userId: a.userId, name: a.name, isAdmin: true })),
    ...room.roomAdminCandidates.map((c) => ({ userId: c.userId, name: c.name, isAdmin: false })),
  ];
  const byId = known.filter((each) => person.userIds.includes(each.userId));
  const matches =
    byId.length > 0
      ? byId
      : known.filter(
          (each) =>
            each.name !== null && (each.name === person.name || each.name === person.fullName)
        );
  if (matches.length !== 1) return null;
  const [match] = matches;
  return {
    userId: match.userId,
    name: match.name ?? person.fullName ?? person.name,
    isAdmin: match.isAdmin,
  };
}

export type RoomAdminAction = {
  /** Whether the person ends up a room admin. */
  admin: boolean;
  label: string;
  /** What to say when the server refuses. */
  failure: string;
};

/**
 * What the viewer may do about someone being a room admin: the room's owner
 * or a workspace admin chooses them, and a room admin may step down.
 */
export function roomAdminAction(
  standing: RoomAdminStanding,
  viewer: { userId: string | null; canManageAdmins: boolean }
): RoomAdminAction | null {
  if (standing.isAdmin && standing.userId === viewer.userId) {
    return {
      admin: false,
      label: 'Step down as room admin',
      failure: 'Could not step down as room admin.',
    };
  }
  if (!viewer.canManageAdmins) return null;
  return standing.isAdmin
    ? {
        admin: false,
        label: 'Remove room admin',
        failure: `Could not remove ${standing.name} as room admin.`,
      }
    : {
        admin: true,
        label: 'Make room admin',
        failure: `Could not make ${standing.name} a room admin.`,
      };
}
