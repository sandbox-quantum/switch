// Where the viewer stands in a room, and what that lets them do, read from
// the server's answers (`room_policy`) rather than worked out again here.

import type { RoomSummary } from "../../data/api";
import { platformLabel } from "../../theme/format";

/** Owning the room, administering the workspace, being one of its room
 * admins, taking part in it, or only seeing it. */
export type RoomStanding = "owner" | "admin" | "room_admin" | "in_room" | "view_only";

type StandingRoom = Pick<
  RoomSummary,
  | "owner_id"
  | "channel_type"
  | "bridge_id"
  | "bridge_type"
  | "viewer_is_member"
  | "viewer_is_room_admin"
  | "can_manage"
  | "can_attach"
  | "can_invite_agents"
  | "can_add_people"
>;

export function roomStanding(room: StandingRoom, viewerId: string | null): RoomStanding {
  if (viewerId !== null && room.owner_id === viewerId) return "owner";
  // Deleting a room is its owner's or an admin's, so anyone else the server
  // lets delete it is a workspace or organization admin.
  if (room.can_manage) return "admin";
  if (room.viewer_is_room_admin) return "room_admin";
  if (room.viewer_is_member) return "in_room";
  return "view_only";
}

export const ROOM_STANDING_LABELS: Record<RoomStanding, string> = {
  owner: "Owner",
  admin: "Workspace admin",
  room_admin: "Room admin",
  in_room: "In the room",
  view_only: "View only",
};

/** What the viewer's standing lets them do, in a sentence or two. */
export function roomStandingText(room: StandingRoom, standing: RoomStanding): string {
  switch (standing) {
    case "owner":
      return "You own this room: you can change it, choose its room admins or delete it.";
    case "admin":
      return "As a workspace admin, you can change this room, choose its room admins or delete it.";
    case "room_admin":
      return (
        "You can change this room's settings, roles and members. Deleting it, changing who " +
        "can see it and choosing room admins stay with its owner and workspace admins."
      );
    case "in_room": {
      const adds = addable(room);
      const changing =
        "Changing the room is for its owner, its room admins and workspace admins.";
      return adds === null ? `You take part in this room. ${changing}` : `You can add ${adds}. ${changing}`;
    }
    case "view_only":
      return ["You can see this room but not change it or add to it.", howToTakePart(room)]
        .filter(Boolean)
        .join(" ");
  }
}

/** "agents, people and resources", or as much of it as the server allows. */
function addable(room: StandingRoom): string | null {
  const things = [
    room.can_invite_agents && "agents",
    room.can_add_people && "people",
    room.can_attach && "resources",
  ].filter((thing): thing is string => typeof thing === "string");
  if (things.length === 0) return null;
  if (things.length === 1) return things[0];
  return `${things.slice(0, -1).join(", ")} and ${things[things.length - 1]}`;
}

/** How someone who only sees a room comes to take part in it, where there is
 * a way they can take themselves: a channel on a messaging app, whose people
 * are in the room once Switch knows their chat account. A direct or group
 * conversation's members are fixed by its platform, and a room on no app has
 * no way in that its viewer can take. */
function howToTakePart(room: StandingRoom): string | null {
  if (!room.bridge_id) return null;
  if (room.channel_type === "direct" || room.channel_type === "group") return null;
  const channel = room.bridge_type ? `its ${platformLabel(room.bridge_type)} channel` : "its channel";
  return (
    `To take part, join ${channel} from a chat account you have linked to Switch, ` +
    "or ask someone in the room to add you."
  );
}
