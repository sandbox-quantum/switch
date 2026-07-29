import { createTheme } from "@mui/material";
import type { PaletteOptions, Shadows } from "@mui/material";
import { HOOT_DARK, HOOT_LIGHT, hootVar } from "./hoot-tokens";

declare module "@mui/material/styles" {
  interface TypeBackground {
    /** The warm canvas the whole app floats on, behind the content surface. */
    canvas: string;
    /** The icon rail / chrome band. Sits bare on the canvas. */
    nav: string;
    /** Inset panels within a card ("cream" tiles). */
    surface: string;
  }
}

/** Identity tint — Switch's own accent, used for avatars and org badges only.
 *  Hoot has no brand accent: `primary` is a near-black reserved for the single
 *  primary action per view (DESIGN.md, "Colors"). */
export const IDENTITY_TINT = "#A1C9D2";

const FONT_SANS = '"Space Grotesk", sans-serif';
const FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

const RADIUS = 10;
const RADIUS_LG = 12;
const RADIUS_XL = 16;

/** "Depth is whispered": borders first, lift from a single soft ambient glow.
 *  A fixed four-rung ladder — surface, card, popover, modal — repeated across
 *  MUI's 25 elevation slots so nothing can stack heavier shadows to fake importance. */
const SURFACE = "0 0 12px 0 rgb(0 0 0 / 0.04)";
const CARD = "0 1px 2px 0 rgb(0 0 0 / 0.04)";
const POPOVER = "0 0 4px 0 rgb(0 0 0 / 0.1), 0 1px 10px 0 rgb(0 0 0 / 0.06)";
const MODAL = "0 0 8px 0 rgb(0 0 0 / 0.12), 0 8px 32px 0 rgb(0 0 0 / 0.12)";

const HOOT_SHADOWS = [
  "none",
  CARD,
  SURFACE,
  SURFACE,
  POPOVER,
  ...Array<string>(20).fill(MODAL),
] as unknown as Shadows;

type HootTokens = { [K in keyof typeof HOOT_LIGHT]: string };

const palette = (t: HootTokens, mode: "light" | "dark"): PaletteOptions => ({
  mode,
  contrastThreshold: 4.5,
  primary: { main: t.primary, contrastText: t.primaryForeground },
  secondary: { main: t.secondary, contrastText: t.secondaryForeground },
  error: { main: t.destructive, contrastText: t.destructiveForeground },
  success: { main: t.success, contrastText: t.successForeground },
  warning: { main: t.warning, contrastText: t.warningForeground },
  background: {
    default: t.background,
    paper: t.card,
    canvas: mode === "light" ? "#f4eee6" : "#0b0b0e",
    nav: t.sidebar,
    surface: t.surface,
  },
  text: { primary: t.foreground, secondary: t.mutedForeground, disabled: t.mutedForeground },
  divider: t.border,
});

/** Every focusable control carries a visible ring (DESIGN.md §12). */
const focusRing = {
  "&.Mui-focusVisible, &:focus-visible": {
    outline: `2px solid ${hootVar("ring")}`,
    outlineOffset: "2px",
  },
} as const;

export const APP_THEME = () =>
  createTheme({
    cssVariables: { colorSchemeSelector: "data-mui-color-scheme" },
    defaultColorScheme: "light",
    colorSchemes: {
      light: { palette: palette(HOOT_LIGHT, "light") },
      dark: { palette: palette(HOOT_DARK, "dark") },
    },
    shape: { borderRadius: RADIUS },
    shadows: HOOT_SHADOWS,
    typography: {
      fontFamily: FONT_SANS,
      // Hierarchy comes from weight and a tight ramp, not size jumps (DESIGN.md).
      h1: { fontSize: "1.8125rem", lineHeight: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.4375rem", lineHeight: "2rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h3: { fontSize: "1.1875rem", lineHeight: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em" },
      h4: { fontSize: "1.0625rem", lineHeight: "1.625rem", fontWeight: 600, letterSpacing: "-0.02em" },
      // Gateway's existing convention is h5 for a page title and h6 for a
      // section title, so those two variants carry Hoot's page and section
      // rungs rather than continuing the ramp downwards.
      h5: { fontSize: "1.8125rem", lineHeight: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h6: { fontSize: "1.1875rem", lineHeight: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em" },
      subtitle1: { fontSize: "0.9375rem", lineHeight: "1.5rem", fontWeight: 500 },
      subtitle2: { fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: 500 },
      body1: { fontSize: "0.9375rem", lineHeight: "1.5rem" },
      body2: { fontSize: "0.875rem", lineHeight: "1.25rem" },
      caption: { fontSize: "0.75rem", lineHeight: "1rem" },
      // Section labels: small, uppercase, letter-spaced, muted — segmenting
      // dense screens without adding chrome.
      overline: {
        fontSize: "0.75rem",
        lineHeight: "1rem",
        fontWeight: 600,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
      },
      button: { fontSize: "0.875rem", fontWeight: 500, textTransform: "none", letterSpacing: 0 },
    },
    components: {
      MuiCssBaseline: {
        styleOverrides: {
          body: { backgroundColor: hootVar("canvas") },
          // Monospace is reserved for identifiers, hashes, IPs and code.
          "code, kbd, samp, pre, .mono": { fontFamily: FONT_MONO },
          // Numbers in tables and metrics line up.
          ".tabular": { fontVariantNumeric: "tabular-nums" },
        },
      },
      MuiAccordion: {
        styleOverrides: { root: { backgroundColor: "inherit", backgroundImage: "none" } },
      },
      MuiButtonBase: {
        styleOverrides: { root: { fontFamily: "inherit", ...focusRing } },
      },
      MuiButton: {
        defaultProps: { disableElevation: true, disableRipple: true },
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            transition: "all 150ms",
            variants: [
              { props: { size: "small" }, style: { height: 32, padding: "0 12px", borderRadius: RADIUS - 2 } },
              { props: { size: "medium" }, style: { height: 36, padding: "0 16px" } },
              { props: { size: "large" }, style: { height: 40, padding: "0 24px", borderRadius: RADIUS + 2 } },
              {
                props: { variant: "contained" },
                style: { boxShadow: CARD, "&:hover": { filter: "brightness(1.1)", boxShadow: CARD } },
              },
              {
                props: { variant: "outlined" },
                style: {
                  borderColor: hootVar("input"),
                  backgroundColor: hootVar("card"),
                  color: hootVar("foreground"),
                  boxShadow: CARD,
                  "&:hover": { borderColor: hootVar("input"), backgroundColor: hootVar("accent") },
                },
              },
              { props: { variant: "outlined", color: "inherit" }, style: { borderColor: hootVar("input") } },
            ],
          },
        },
      },
      MuiCard: {
        defaultProps: { variant: "outlined" },
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            borderColor: hootVar("border"),
            backgroundColor: hootVar("card"),
            boxShadow: CARD,
            backgroundImage: "none",
          },
        },
      },
      // Hoot's Badge: a small rounded pill driven by a semantic variant, never
      // a hand-picked colour.
      MuiChip: {
        styleOverrides: {
          root: {
            height: 24,
            borderRadius: 8,
            fontSize: "0.875rem",
            fontWeight: 500,
            "& .MuiChip-label": { paddingLeft: 8, paddingRight: 8 },
            // Status colours are rationed: a filled chip reads as a tinted
            // wash of its semantic hue, never a saturated block.
            variants: [
              {
                props: { variant: "filled", color: "default" },
                style: { backgroundColor: hootVar("muted"), color: hootVar("muted-foreground") },
              },
              {
                props: { variant: "filled", color: "success" },
                style: { backgroundColor: hootVar("success-muted"), color: hootVar("success") },
              },
              {
                props: { variant: "filled", color: "warning" },
                style: { backgroundColor: hootVar("warning-muted"), color: hootVar("warning") },
              },
              {
                props: { variant: "filled", color: "error" },
                style: { backgroundColor: hootVar("destructive-muted"), color: hootVar("destructive") },
              },
            ],
          },
          outlined: { borderColor: hootVar("border"), backgroundColor: "transparent" },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: hootVar("border") } } },
      MuiDrawer: {
        defaultProps: {
          elevation: 0,
          slotProps: { backdrop: { sx: { backgroundColor: "rgb(0 0 0 / 0.6)" } } },
        },
        styleOverrides: { paper: { backgroundColor: hootVar("canvas"), borderRight: "none" } },
      },
      // Modals rest above a dimmed backdrop. Scoped to Dialog and Drawer —
      // menus and popovers mount an invisible backdrop that must stay invisible.
      MuiDialog: {
        defaultProps: {
          slotProps: { backdrop: { sx: { backgroundColor: "rgb(0 0 0 / 0.6)" } } },
        },
        styleOverrides: {
          paper: { borderRadius: RADIUS_LG, boxShadow: MODAL, backgroundColor: hootVar("card") },
        },
      },
      MuiIconButton: {
        defaultProps: { size: "small" },
        styleOverrides: { root: { borderRadius: RADIUS } },
      },
      MuiListItemButton: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            "&.Mui-selected": { backgroundColor: hootVar("muted"), fontWeight: 500 },
          },
        },
      },
      MuiMenu: { defaultProps: { elevation: 4 } },
      MuiMenuItem: { styleOverrides: { root: { borderRadius: 6, fontSize: "0.875rem" } } },
      MuiPaper: {
        defaultProps: { variant: "outlined", elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: "none", borderColor: hootVar("border") },
          rounded: { borderRadius: RADIUS },
        },
      },
      MuiPopover: {
        defaultProps: { elevation: 4 },
        styleOverrides: { paper: { borderRadius: RADIUS_LG, boxShadow: POPOVER } },
      },
      MuiOutlinedInput: {
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            backgroundColor: "transparent",
            "& .MuiOutlinedInput-notchedOutline": { borderColor: hootVar("input") },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: hootVar("border-strong") },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: hootVar("ring"),
              borderWidth: 1,
            },
            "&.Mui-focused": { outline: `2px solid ${hootVar("ring")}`, outlineOffset: "1px" },
          },
          input: { fontSize: "0.875rem" },
        },
      },
      MuiSvgIcon: { defaultProps: { fontSize: "inherit" } },
      MuiSwitch: { defaultProps: { size: "small" } },
      // Underline tabs with a foreground indicator — chrome recedes.
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { height: 2, backgroundColor: hootVar("foreground") },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minWidth: "auto",
            minHeight: 40,
            padding: "4px 16px 12px",
            fontSize: "0.875rem",
            color: hootVar("muted-foreground"),
            "&.Mui-selected": { color: hootVar("foreground"), fontWeight: 500 },
          },
        },
      },
      MuiTextField: { defaultProps: { size: "small", fullWidth: true, variant: "outlined" } },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: {
            fontSize: "0.75rem",
            lineHeight: "1.1rem",
            textAlign: "center",
            borderRadius: RADIUS,
            padding: "8px 12px",
            backgroundColor: hootVar("foreground"),
            color: hootVar("background"),
          },
          arrow: { color: hootVar("foreground") },
        },
      },
    },
  });

export const HOOT_RADIUS = { base: RADIUS, lg: RADIUS_LG, xl: RADIUS_XL };
export const HOOT_ELEVATION = { card: CARD, surface: SURFACE, popover: POPOVER, modal: MODAL };
