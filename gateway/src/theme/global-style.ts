import type { GlobalStylesProps } from "@mui/material";

export const GLOBAL_STYLE: GlobalStylesProps["styles"] = {
  ":root": {
    // Hoot's shell: a narrow icon rail and a slim top bar framing one rounded
    // content surface. Both sit bare on the canvas.
    "--nav-rail-width": "5rem",
    "--top-bar-height": "3rem",
    "--surface-gutter": "0.5rem",
    "--main-toolbar-height": "4rem",
  },
  "*": {
    scrollbarWidth: "thin",
  },
  ".sticky-toolbar": {
    position: "sticky !important",
    top: 0,
    zIndex: "var(--mui-zIndex-appBar)",
    backgroundColor: "var(--hoot-card)",
    borderBottom: "1px solid",
    borderBottomColor: "var(--hoot-border)",
    boxSizing: "content-box",
  },
  // Newly appearing content gets a gentle entrance (DESIGN.md §15).
  "@keyframes hoot-slide-up-fade": {
    from: { opacity: 0, transform: "translateY(14px)" },
    to: { opacity: 1, transform: "translateY(0)" },
  },
  ".hoot-enter": {
    animation: "hoot-slide-up-fade 0.5s cubic-bezier(0.16, 1, 0.3, 1) both",
  },
  "@media (prefers-reduced-motion: reduce)": {
    ".hoot-enter": { animation: "none" },
  },
};
