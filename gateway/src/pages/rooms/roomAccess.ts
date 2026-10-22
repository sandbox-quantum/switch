import type { VisibilityPair } from "../../data/visibility";

/** Whether a user may write to a room, as the server decides it (`can(...,
 * "write", room)` in `switch_core.authz`): its owner, a tenant admin, or
 * anyone when the room is publicly writable. */
export function canWriteRoom(
  room: VisibilityPair & { owner_id: string | null },
  userId: string | null | undefined,
  canAdminTenant: boolean,
): boolean {
  if (!userId) return false;
  return (
    canAdminTenant ||
    (room.owner_id !== null && room.owner_id === userId) ||
    room.write_visibility === "public"
  );
}

/** Whether a user may open an owned resource (a room, a package), as the
 * server decides it (`can(..., "read", ...)`): its owner, a tenant admin, or
 * anyone when it is publicly readable. */
export function canReadResource(
  resource: Pick<VisibilityPair, "read_visibility"> & { owner_id: string | null },
  userId: string | null | undefined,
  canAdminTenant: boolean,
): boolean {
  if (!userId) return false;
  return (
    canAdminTenant ||
    (resource.owner_id !== null && resource.owner_id === userId) ||
    resource.read_visibility === "public"
  );
}
