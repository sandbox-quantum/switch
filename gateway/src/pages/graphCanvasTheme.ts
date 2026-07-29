import { useColorScheme } from "@mui/material";
import { HOOT_DARK, HOOT_LIGHT } from "../theme/hoot-tokens";

/** Canvas paints outside the CSS cascade, so the force-graph views can't read
 *  `var(--hoot-*)`. Resolve the active scheme's tokens to concrete colours here
 *  so the graphs follow the theme instead of hardcoding a dark slab. */
export interface GraphCanvasTheme {
  /** Canvas fill — the graph sits on the same surface as the rest of the page. */
  background: string;
  /** Node label ink. */
  label: string;
  /** Ring drawn around a node to separate it from the canvas. */
  nodeStroke: string;
  /** Edges recede: visible, never competing with the nodes. */
  link: string;
  /** Muted ink for de-emphasised labels. */
  labelMuted: string;
  fontFamily: string;
}

const FONT = "Space Grotesk, sans-serif";

export function useGraphCanvasTheme(): GraphCanvasTheme {
  const { mode, systemMode } = useColorScheme();
  const resolved = mode === "system" ? (systemMode ?? "light") : (mode ?? "light");
  const t = resolved === "dark" ? HOOT_DARK : HOOT_LIGHT;

  return {
    background: t.card,
    label: t.foreground,
    labelMuted: t.mutedForeground,
    nodeStroke: t.card,
    link: resolved === "dark" ? "rgba(255,255,255,0.22)" : "rgba(0,0,0,0.18)",
    fontFamily: FONT,
  };
}
