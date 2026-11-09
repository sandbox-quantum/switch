// A short fade when a cloud state changes (UX pass, proposal item 3): the
// panel's heading and each agent's status line settle in rather than jump.
// Opacity only, no movement, and nothing at all under "reduce motion".

import { keyframes } from "@emotion/react";
import { Box } from "@mui/material";
import { type ReactNode, useRef } from "react";

const settle = keyframes`
  from { opacity: 0.2; }
  to { opacity: 1; }
`;

export const FADE_SX = {
  animation: `${settle} 0.4s ease-out both`,
  "@media (prefers-reduced-motion: reduce)": { animation: "none" },
} as const;

/**
 * Its children, faded in each time `state` changes. Not on first show: a
 * page that has just opened has nothing to draw the eye to.
 */
export default function StateFade({
  state,
  children,
  component = "span",
}: {
  state: string;
  children: ReactNode;
  component?: "span" | "div";
}) {
  const first = useRef(state);
  const moved = useRef(false);
  if (state !== first.current) moved.current = true;
  return (
    <Box
      key={state}
      component={component}
      data-state-fade={moved.current ? "on" : undefined}
      sx={moved.current ? FADE_SX : undefined}
    >
      {children}
    </Box>
  );
}
