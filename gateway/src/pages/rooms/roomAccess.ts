import type { AccessLevel, Visibility } from "../../data/visibility";

/** A room is public or private: who may see it. Changing a room is its
 * owner's and the admins' either way, so a room has no "read & write" or
 * "read only" level, and its write visibility is not read. */
export type RoomAccessLevel = Extract<AccessLevel, "public" | "private">;

export const ROOM_ACCESS_LEVELS: RoomAccessLevel[] = ["public", "private"];

export function roomAccessOf(room: { read_visibility: Visibility }): RoomAccessLevel {
  return room.read_visibility === "public" ? "public" : "private";
}

/** What a channel of this type makes a new room: private when only the
 * channel's members can see it. Matches the server's `visibility_for_channel`. */
export function roomAccessForChannel(channelType: string): RoomAccessLevel {
  return channelType === "channel_private" || channelType === "group" || channelType === "direct"
    ? "private"
    : "public";
}

/** The access levels as they apply to a room. The shared wording speaks to
 * the owner ("only you"); this holds for whoever is viewing, and a private
 * room is also seen by those taking part in it. */
export const ROOM_ACCESS_HELPERS: Partial<Record<AccessLevel, string>> = {
  private:
    "Only those taking part in the room, its owner and admins can see it. Only its owner and admins can change it.",
  public:
    "Everyone in the workspace can see it. Only its owner and admins can change it; the people in it can add to it.",
};

export const ROOM_ACCESS_OPTION_LABELS: Partial<Record<AccessLevel, string>> = {
  private: "Private",
  public: "Public",
};
