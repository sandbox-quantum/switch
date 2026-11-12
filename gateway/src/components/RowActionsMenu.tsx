import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { type ReactNode, useId, useState } from "react";

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Removes or revokes something: drawn in the destructive colour. */
  destructive?: boolean;
  /** Why the action is unavailable to this viewer, as the server words it
   *  (an object's `*_blocked_reason`). A string disables the item and shows
   *  the reason under its label: a greyed item with no explanation is the
   *  thing people file bugs about. Null or absent leaves it available. */
  disabledReason?: string | null;
}

/**
 * The "…" at the end of a table row and the menu it opens. An action follows
 * the server's answer for its object: hidden, by leaving it out of `actions`,
 * when the viewer may not take it and there is no reason to give; disabled
 * with the reason when there is one. With nothing left to offer, the row has
 * no "…" at all rather than one that opens an empty menu.
 *
 * A disabled item stays in the menu with its reason under it, and stays
 * reachable by keyboard and screen reader (it is `aria-disabled`, not removed
 * from the focus order), so the reason can be read.
 *
 * Clicks and keys inside are kept from reaching the row: React carries events
 * up through the menu's portal, and a row click usually opens the row.
 *
 * `tabIndex` is the cell's, from the grid's `renderCell` params: the grid is
 * one Tab stop that arrow keys move within, and a "…" that is a Tab stop of
 * its own on every row would make tabbing past a table take a press a row.
 */
export default function RowActionsMenu({
  label,
  actions,
  tabIndex,
}: {
  label: string;
  actions: RowAction[];
  tabIndex: number;
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerId = useId();
  const close = () => setAnchor(null);

  if (actions.length === 0) return null;

  return (
    <>
      <IconButton
        id={triggerId}
        aria-label={label}
        tabIndex={tabIndex}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
        sx={{ width: 28, height: 28, color: "var(--sw-foreground)" }}
      >
        <MoreHorizOutlined sx={{ fontSize: 16 }} />
      </IconButton>
      <Menu
        open={anchor !== null}
        anchorEl={anchor}
        onClose={close}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        // MUI's arrow-key navigation skips aria-disabled items unless told
        // otherwise, which would make a disabled action's reason unreachable.
        slotProps={{
          paper: { sx: { width: 280 } },
          list: { "aria-labelledby": triggerId, disabledItemsFocusable: true, sx: { p: 0.5 } },
        }}
      >
        {actions.map((action) => {
          const disabled = action.disabledReason != null;
          const tone = disabled
            ? "var(--sw-field-disabled-foreground)"
            : action.destructive
              ? "var(--sw-destructive-text)"
              : undefined;
          return (
            <MenuItem
              key={action.label}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (disabled) return;
                close();
                action.onClick();
              }}
              sx={{
                alignItems: "flex-start",
                whiteSpace: "normal",
                minHeight: 36,
                px: 1.5,
                py: 1,
                color: tone,
                // A destructive action hovers in its own red wash.
                ...(action.destructive &&
                  !disabled && { "&:hover, &.Mui-focusVisible": { backgroundColor: "var(--sw-destructive-muted)" } }),
                ...(disabled && { cursor: "default", "&:hover": { backgroundColor: "transparent" } }),
              }}
            >
              {action.icon && (
                <ListItemIcon sx={{ color: "inherit", minWidth: 24, mt: "2px", "& svg": { fontSize: 16 } }}>
                  {action.icon}
                </ListItemIcon>
              )}
              <ListItemText
                primary={action.label}
                secondary={action.disabledReason}
                sx={{ my: 0 }}
                slotProps={{
                  primary: { variant: "body2" },
                  secondary: { variant: "caption", color: "text.secondary", display: "block", sx: { mt: 0.25 } },
                }}
              />
            </MenuItem>
          );
        })}
      </Menu>
    </>
  );
}
