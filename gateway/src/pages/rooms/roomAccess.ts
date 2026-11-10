import type { AccessLevel } from "../../data/visibility";

/** The access levels as they apply to a room. The shared wording speaks to
 * the owner ("only you"); this holds for whoever is viewing, and a private
 * room is also seen by those taking part in it. */
export const ROOM_ACCESS_HELPERS: Record<AccessLevel, string> = {
  private:
    "Only those taking part in the room, its owner and admins can see it. Only its owner and admins can change it.",
  read_only:
    "Everyone in the workspace can see it. Only its owner and admins can change it.",
  public:
    "Everyone in the workspace can see it, the same as read only. Only its owner and admins can change it; the people in it can add to it.",
};

export const ROOM_ACCESS_OPTION_LABELS: Partial<Record<AccessLevel, string>> = {
  private: "Private",
};
