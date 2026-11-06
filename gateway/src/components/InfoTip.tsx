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
      slotProps={{ tooltip: { sx: { maxWidth: 288, textAlign: "left" } } }}
    >
      <IconButton
        aria-label={label}
        sx={{ color: "text.secondary", p: 0.25, "&:hover": { color: "text.primary", backgroundColor: "transparent" } }}
      >
        <HelpOutlineOutlined sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );
}
