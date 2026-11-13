import { Chip } from "@mui/material";

import type { Visibility } from "../../data/visibility";
import { ROOM_ACCESS_OPTION_LABELS, roomAccessOf } from "./roomAccess";

/** A room's access as a chip: Public or Private. Its write visibility is not
 * read, so a room once "read & write" shows as Public like the rest. */
export function RoomAccessChip({ room }: { room: { read_visibility: Visibility } }) {
  return <Chip label={ROOM_ACCESS_OPTION_LABELS[roomAccessOf(room)]} size="small" color="default" />;
}
