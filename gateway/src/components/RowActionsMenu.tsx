import MoreHorizOutlined from "@mui/icons-material/MoreHorizOutlined";
import { IconButton, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { type ReactNode, useId, useState } from "react";

export interface RowAction {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
  /** Removes or revokes something: drawn in the destructive colour. */
  destructive?: boolean;
  /** Why the action is unavailable to this viewer. Setting it disables the
   *  item and shows the reason under its label: a greyed item with no
   *  explanation is the thing people file bugs about. */
  disabledReason?: string;
}

/**
 * The "…" at the end of a table row and the menu it opens. A disabled item
 * stays in the menu with its reason under it, and stays reachable by keyboard
 * and screen reader (it is `aria-disabled`, not removed from the focus order),
 * so the reason can be read.
 *
 * Clicks and keys inside are kept from reaching the row: React carries events
 * up through the menu's portal, and a row click usually opens the row.
 */
export default function RowActionsMenu({ label, actions }: { label: string; actions: RowAction[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const triggerId = useId();
  const close = () => setAnchor(null);

  return (
    <>
      <IconButton
        id={triggerId}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={anchor ? "true" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setAnchor(event.currentTarget);
        }}
      >
        <MoreHorizOutlined fontSize="small" />
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
          list: { "aria-labelledby": triggerId, disabledItemsFocusable: true },
          paper: { sx: { width: 280 } },
        }}
      >
        {actions.map((action) => {
          const disabled = action.disabledReason !== undefined;
          const tone = disabled
            ? "var(--hoot-field-disabled-foreground)"
            : action.destructive
              ? "var(--hoot-destructive)"
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
                color: tone,
                ...(disabled && { cursor: "default", "&:hover": { backgroundColor: "transparent" } }),
              }}
            >
              {action.icon && <ListItemIcon sx={{ color: "inherit", mt: "2px" }}>{action.icon}</ListItemIcon>}
              <ListItemText
                primary={action.label}
                secondary={action.disabledReason}
                slotProps={{
                  primary: { variant: "body2", fontWeight: 500 },
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
