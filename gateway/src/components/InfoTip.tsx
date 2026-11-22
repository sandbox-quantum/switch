import HelpOutlineOutlined from "@mui/icons-material/HelpOutlineOutlined";
import { IconButton, Tooltip } from "@mui/material";
import type { ReactNode } from "react";

/**
 * The small question mark that holds a page's secondary facts, so the page
 * itself carries no explanatory prose. Hover, keyboard focus and a tap all
 * open it, and the text wraps: it is written in sentences.
 *
 *   <InfoTip>Connectors are off by default for new workspaces.</InfoTip>
 */
export default function InfoTip({ children, label = "More information" }: { children: ReactNode; label?: string }) {
  return (
    <Tooltip
      title={children}
      describeChild
      enterTouchDelay={0}
      leaveTouchDelay={4000}
      // The design system's info tip opens above the mark, 6px off it and with no arrow,
      // and flips below only when there is no room.
      placement="top"
      arrow={false}
      slotProps={{
        popper: { modifiers: [{ name: "offset", options: { offset: [0, 6] } }] },
        tooltip: {
          sx: {
            maxWidth: 288,
            textAlign: "left",
            fontWeight: 400,
            lineHeight: "16px",
            boxShadow: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
            ".MuiTooltip-popper[data-popper-placement] &": { m: 0 },
          },
        },
      }}
    >
      <IconButton
        aria-label={label}
        sx={{
          width: 16,
          height: 16,
          p: 0,
          color: "text.secondary",
          "&:hover": { color: "text.primary", backgroundColor: "transparent" },
        }}
      >
        <HelpOutlineOutlined sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}
