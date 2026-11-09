import ChevronRight from "@mui/icons-material/ChevronRight";
import LockOutlined from "@mui/icons-material/LockOutlined";
import { Tooltip } from "@mui/material";

/**
 * How a list row says whether it opens: a chevron at the end of one that does,
 * a lock beside the name of one the viewer may not open (an item its owner
 * keeps private, listed because what holds it is shared), whose text is also
 * dimmed. Every list that can show such an item uses these, so they read the
 * same everywhere.
 */

export const LOCKED_ROW_HINT = "Private to its owner, so you can't open it.";

/** Beside the name of an item the viewer may not open. */
export function LockedMark() {
  return (
    <Tooltip title={LOCKED_ROW_HINT}>
      {/* `titleAccess`: MUI hides an icon from screen readers unless it
          has a title. The tooltip then names it with the hint. */}
      <LockOutlined
        titleAccess="Private"
        sx={{ fontSize: 14, color: "text.secondary" }}
      />
    </Tooltip>
  );
}

/** At the end of a row that opens something. */
export function OpensMark() {
  return (
    <ChevronRight
      aria-hidden
      fontSize="small"
      sx={{ color: "text.disabled" }}
    />
  );
}
