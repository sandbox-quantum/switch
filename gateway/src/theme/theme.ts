import { createTheme } from "@mui/material";
import type { PaletteOptions, Shadows, Theme } from "@mui/material";
import type {} from "@mui/x-data-grid/themeAugmentation";
import { TOKENS_DARK, TOKENS_LIGHT, tokenVar } from "./tokens";

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
 *  The design system has no brand accent: `primary` is a near-black reserved for the single
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
/** Firmer than the design system's own popover glow: a menu shares the card's fill, so
 *  over a table of the same colour only its shadow sets it apart. */
const POPOVER = "0 2px 6px 0 rgb(0 0 0 / 0.08), 0 10px 28px 0 rgb(0 0 0 / 0.14)";
const MODAL = "0 0 8px 0 rgb(0 0 0 / 0.12), 0 8px 32px 0 rgb(0 0 0 / 0.12)";
/** On a near-black page a soft shadow vanishes, so a dark menu's is deeper. */
const POPOVER_DARK = "0 2px 6px 0 rgb(0 0 0 / 0.4), 0 10px 28px 0 rgb(0 0 0 / 0.6)";

/** A status in the banner treatment: the tone's light wash, a hairline of the
 *  tone a step darker, and text in its deep shade in light mode and its pale
 *  one in dark, which MUI's Alert palette keeps well above AA. Chips and
 *  banners share it, so a status chip reads as a small banner. */
export type StatusTone = "success" | "warning" | "error" | "info";
export const statusEdge = (tone: StatusTone) =>
  `color-mix(in oklch, var(--mui-palette-${tone}-main) 35%, transparent)`;
export const statusTone = (tone: StatusTone) => ({
  backgroundColor: `var(--mui-palette-Alert-${tone}StandardBg)`,
  color: `var(--mui-palette-Alert-${tone}Color)`,
  // MUI darkens a dark-mode wash below the card, which reads as a hole; a
  // light tint of the tone over the card reads as the light-mode one does.
  '[data-mui-color-scheme="dark"] &': {
    backgroundColor: `color-mix(in oklch, var(--mui-palette-${tone}-main) 12%, transparent)`,
  },
});

/** Everything that floats over a card: menus, popovers, autocomplete lists
 *  and the grid's own menus and panels. They share the card's fill, so only
 *  a firm edge and a shadow set them apart from what they cover. */
const floating = (theme: Theme) => ({
  borderRadius: RADIUS_LG,
  border: `1px solid ${tokenVar("field-border")}`,
  backgroundColor: tokenVar("popover"),
  backgroundImage: "none",
  boxShadow: POPOVER,
  ...theme.applyStyles("dark", { boxShadow: POPOVER_DARK }),
});

const SHADOWS = [
  "none",
  CARD,
  SURFACE,
  SURFACE,
  POPOVER,
  ...Array<string>(20).fill(MODAL),
] as unknown as Shadows;

type Tokens = { [K in keyof typeof TOKENS_LIGHT]: string };

const palette = (t: Tokens, mode: "light" | "dark"): PaletteOptions => ({
  mode,
  contrastThreshold: 4.5,
  primary: { main: t.primary, contrastText: t.primaryForeground },
  secondary: { main: t.secondary, contrastText: t.secondaryForeground },
  // Red as text and icons is the darker-in-light, lighter-in-dark mix, which
  // reads at small sizes in both schemes; a filled button keeps the design system's red
  // (see MuiButton).
  error: { main: t.destructiveText, contrastText: t.destructiveForeground },
  success: { main: t.success, contrastText: t.successForeground },
  // The design system pairs brand black, never white, with its orange.
  warning: { main: t.warning, contrastText: t.brandBlack },
  background: {
    default: t.background,
    paper: t.card,
    canvas: t.canvas,
    nav: t.sidebar,
    surface: t.surface,
  },
  // Disabled text is the disabled-field grey, not the secondary text
  // colour: a control that is disabled has to look it, since "disabled, with
  // the reason" is how the gateway shows an action the viewer may not take.
  text: { primary: t.foreground, secondary: t.mutedForeground, disabled: t.fieldDisabledForeground },
  divider: t.border,
});

/** Every focusable control carries a visible ring (DESIGN.md §12). */
const focusRing = {
  "&.Mui-focusVisible, &:focus-visible": {
    outline: `2px solid ${tokenVar("ring")}`,
    outlineOffset: "2px",
  },
} as const;

/**
 * Switches off the modifier MUI's Popper adds to copy popper.js's placement
 * into React state. The Popper re-positions after every render, and that copy
 * then queues an update even when the placement has not changed. Typing faster
 * than the browser yields to React's scheduler (a paste-by-key tool, a
 * scanner, fuzzed input) while a Popper is mounted, an Autocomplete's popup or
 * a data grid's column menu, piles one up per keystroke, and the 51st trips
 * React's "Maximum update depth exceeded" (#185). popper.js still positions
 * the popup; only the placement a flip picks is no longer reported back.
 *
 * Given as `popperOptions` because the Popper appends those modifiers after
 * the ones a component passes, as the data grid does. A Tooltip passes its own
 * `popperOptions` and so keeps the report, which its arrow needs. A module
 * constant because the Popper rebuilds itself whenever its options change.
 */
const POPPER_OPTIONS = { modifiers: [{ name: "onUpdate", enabled: false }] };

export const APP_THEME = () =>
  createTheme({
    cssVariables: { colorSchemeSelector: "data-mui-color-scheme" },
    defaultColorScheme: "light",
    colorSchemes: {
      light: { palette: palette(TOKENS_LIGHT, "light") },
      dark: { palette: palette(TOKENS_DARK, "dark") },
    },
    shape: { borderRadius: RADIUS },
    shadows: SHADOWS,
    typography: {
      fontFamily: FONT_SANS,
      // Hierarchy comes from weight and a tight ramp, not size jumps (DESIGN.md).
      h1: { fontSize: "1.8125rem", lineHeight: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h2: { fontSize: "1.4375rem", lineHeight: "2rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h3: { fontSize: "1.1875rem", lineHeight: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em" },
      h4: { fontSize: "1.0625rem", lineHeight: "1.625rem", fontWeight: 600, letterSpacing: "-0.02em" },
      // Gateway's existing convention is h5 for a page title and h6 for a
      // section title, so those two variants carry the design system's page and section
      // rungs rather than continuing the ramp downwards.
      h5: { fontSize: "1.8125rem", lineHeight: "2.25rem", fontWeight: 700, letterSpacing: "-0.02em" },
      h6: { fontSize: "1.1875rem", lineHeight: "1.75rem", fontWeight: 600, letterSpacing: "-0.02em" },
      subtitle1: { fontSize: "0.9375rem", lineHeight: "1.5rem", fontWeight: 500 },
      subtitle2: { fontSize: "0.875rem", lineHeight: "1.25rem", fontWeight: 500 },
      body1: { fontSize: "0.9375rem", lineHeight: "1.5rem" },
      body2: { fontSize: "0.875rem", lineHeight: "1.25rem" },
      caption: { fontSize: "0.8125rem", lineHeight: "1rem" },
      // Section labels: small, uppercase, letter-spaced, muted — segmenting
      // dense screens without adding chrome.
      overline: {
        fontSize: "0.8125rem",
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
          body: { backgroundColor: tokenVar("canvas") },
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
                  borderColor: tokenVar("input"),
                  backgroundColor: tokenVar("card"),
                  color: tokenVar("foreground"),
                  boxShadow: CARD,
                  "&:hover": { borderColor: tokenVar("input"), backgroundColor: tokenVar("accent") },
                },
              },
              { props: { variant: "outlined", color: "inherit" }, style: { borderColor: tokenVar("input") } },
              // The destructive outline: an action that removes something but
              // asks first, so it does not shout like the confirm itself. Red
              // as ink and a hairline, filled only on hover; the ink is the
              // text red, which keeps small text at AA.
              {
                props: { variant: "outlined", color: "error" },
                style: {
                  color: tokenVar("destructive-text"),
                  borderColor: `color-mix(in oklch, ${tokenVar("destructive")} 45%, transparent)`,
                  "&:hover": {
                    borderColor: `color-mix(in oklch, ${tokenVar("destructive")} 45%, transparent)`,
                    backgroundColor: tokenVar("destructive-muted"),
                  },
                },
              },
              {
                props: { variant: "contained", color: "error" },
                style: {
                  backgroundColor: tokenVar("destructive"),
                  color: tokenVar("destructive-foreground"),
                  "&:hover": { backgroundColor: tokenVar("destructive") },
                },
              },
            ],
          },
        },
      },
      MuiCard: {
        defaultProps: { variant: "outlined" },
        styleOverrides: {
          root: {
            borderRadius: RADIUS,
            borderColor: tokenVar("border"),
            backgroundColor: tokenVar("card"),
            boxShadow: CARD,
            backgroundImage: "none",
          },
        },
      },
      // The design system's Badge: a small rounded pill driven by a semantic variant, never
      // a hand-picked colour.
      MuiChip: {
        styleOverrides: {
          root: {
            height: 24,
            borderRadius: 8,
            fontSize: "0.875rem",
            fontWeight: 500,
            "& .MuiChip-label": { paddingLeft: 8, paddingRight: 8 },
            // A chip's icon is its label's colour, not MUI's grey.
            "& .MuiChip-icon": { color: "inherit", fontSize: 16, marginLeft: 6, marginRight: -2 },
            // A filled chip is a small banner: its tone's wash, a hairline a
            // step darker (drawn inset, so the chip keeps its height) and text
            // in the tone's readable shade. Grey for a state with no tone.
            variants: [
              {
                props: { variant: "filled", color: "default" },
                style: {
                  backgroundColor: tokenVar("muted"),
                  color: tokenVar("muted-foreground"),
                  boxShadow: `inset 0 0 0 1px color-mix(in oklch, ${tokenVar("foreground")} 14%, transparent)`,
                },
              },
              ...(["success", "warning", "error", "info"] as const).map((tone) => ({
                props: { variant: "filled" as const, color: tone },
                style: { ...statusTone(tone), boxShadow: `inset 0 0 0 1px ${statusEdge(tone)}` },
              })),
            ],
          },
          outlined: { borderColor: tokenVar("border"), backgroundColor: "transparent" },
        },
      },
      // A banner's edge is its tone a step darker than its wash, as a status
      // chip's is.
      MuiAlert: {
        styleOverrides: {
          root: {
            // One radius for every banner, the page banner's.
            borderRadius: 6,
            variants: (["success", "warning", "error", "info"] as const).map((tone) => ({
              props: { variant: "standard" as const, severity: tone },
              style: { ...statusTone(tone), border: `1px solid ${statusEdge(tone)}` },
            })),
          },
        },
      },
      MuiDivider: { styleOverrides: { root: { borderColor: tokenVar("border") } } },
      MuiDrawer: {
        defaultProps: {
          elevation: 0,
          slotProps: { backdrop: { sx: { backgroundColor: tokenVar("overlay") } } },
        },
        styleOverrides: { paper: { backgroundColor: tokenVar("canvas"), borderRight: "none" } },
      },
      // Modals rest above a dimmed backdrop. Scoped to Dialog and Drawer —
      // menus and popovers mount an invisible backdrop that must stay invisible.
      MuiDialog: {
        defaultProps: {
          slotProps: {
            backdrop: {
              // The design system's overlay is its warm black at 60%, which barely dims a
              // page that is already near-black; dark mode dims with black.
              sx: (theme: Theme) => ({
                backgroundColor: tokenVar("overlay"),
                ...theme.applyStyles("dark", { backgroundColor: "rgb(0 0 0 / 0.7)" }),
              }),
            },
          },
        },
        styleOverrides: {
          paper: { borderRadius: RADIUS_LG, boxShadow: MODAL, backgroundColor: tokenVar("card") },
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
            "&.Mui-selected": { backgroundColor: tokenVar("muted"), fontWeight: 500 },
          },
        },
      },
      MuiMenu: { defaultProps: { elevation: 4 } },
      MuiMenuItem: {
        styleOverrides: {
          root: {
            borderRadius: 6,
            fontSize: "0.875rem",
            // A full-width item's ring drawn outside it would be clipped by
            // the menu to two stray lines, so it is drawn inside.
            "&.Mui-focusVisible, &:focus-visible": { outlineOffset: "-2px" },
          },
        },
      },
      MuiPaper: {
        defaultProps: { variant: "outlined", elevation: 0 },
        styleOverrides: {
          root: { backgroundImage: "none", borderColor: tokenVar("border") },
          rounded: { borderRadius: RADIUS },
        },
      },
      MuiPopover: {
        defaultProps: { elevation: 4 },
        styleOverrides: { paper: ({ theme }) => floating(theme) },
      },
      MuiAutocomplete: {
        styleOverrides: {
          paper: ({ theme }) => floating(theme),
          // A chip on a field shares its fill in dark mode, so it keeps an edge.
          tag: { border: `1px solid ${tokenVar("border")}` },
          // 36px like every other field: the list's own input padding plus
          // this makes the 20px of text the same 8px from the edge.
          inputRoot: {
            "&.MuiInputBase-sizeSmall": { paddingTop: 5.5, paddingBottom: 5.5, paddingLeft: 8 },
          },
          popupIndicator: { color: tokenVar("muted-foreground") },
        },
      },
      MuiDataGrid: {
        styleOverrides: { paper: ({ theme }) => floating(theme) },
      },
      // The field chrome: a white field on a hairline with one soft shadow,
      // and on focus a full-strength border with a soft ring hugging it.
      // The field label sits above the box, 14px and medium, 6px clear of
      // it, as in DESIGN.md's form fields: never a label floating inside the
      // box that reads as placeholder text, and so no notch in the border.
      MuiInputLabel: {
        defaultProps: { shrink: true },
        styleOverrides: {
          root: {
            position: "static",
            transform: "none",
            maxWidth: "none",
            marginBottom: 6,
            fontSize: "0.875rem",
            fontWeight: 500,
            lineHeight: 1.25,
            color: tokenVar("foreground"),
            "&.Mui-focused": { color: tokenVar("foreground") },
            // The box and the message below it carry the error; the label
            // stays in ink, as the design system's does.
            "&.Mui-error": { color: tokenVar("foreground") },
            "&.Mui-disabled": { color: tokenVar("field-disabled-foreground") },
          },
        },
      },
      MuiFormHelperText: {
        styleOverrides: {
          root: {
            margin: "6px 0 0",
            fontSize: "0.875rem",
            lineHeight: 1.4,
            color: tokenVar("muted-foreground"),
            "&.Mui-error": { color: tokenVar("destructive-text") },
            // Under a disabled field the helper is usually why it is
            // disabled, which has to stay readable.
            "&.Mui-disabled": { color: tokenVar("muted-foreground") },
          },
        },
      },
      // MUI's toggle text is a 54% black, under 4.5:1 on the sand page.
      MuiToggleButton: {
        styleOverrides: {
          root: {
            color: tokenVar("muted-foreground"),
            "&.Mui-selected, &.Mui-selected:hover": { color: tokenVar("foreground") },
          },
        },
      },
      MuiOutlinedInput: {
        defaultProps: { notched: false },
        styleOverrides: {
          notchedOutline: { top: 0, "& legend": { display: "none" } },
          root: {
            borderRadius: RADIUS - 2,
            backgroundColor: tokenVar("field"),
            boxShadow: tokenVar("field-shadow"),
            transition: "box-shadow 150ms",
            "& .MuiOutlinedInput-notchedOutline": {
              borderColor: tokenVar("field-border"),
              transition: "border-color 150ms",
            },
            "&:hover .MuiOutlinedInput-notchedOutline": { borderColor: tokenVar("field-border-hover") },
            "&.Mui-focused": { boxShadow: `${tokenVar("field-shadow")}, 0 0 0 2px ${tokenVar("field-ring")}` },
            "&.Mui-focused .MuiOutlinedInput-notchedOutline": {
              borderColor: tokenVar("field-border-focus"),
              borderWidth: 1,
            },
            "&.Mui-error .MuiOutlinedInput-notchedOutline": { borderColor: tokenVar("destructive") },
            // Focus shows on a field in error as on any other: the error's red
            // edge stays, and the ring is a firm red, not a faint wash.
            "&.Mui-error.Mui-focused": {
              boxShadow: `${tokenVar("field-shadow")}, 0 0 0 2px color-mix(in oklch, ${tokenVar("destructive-text")} 45%, transparent)`,
            },
            "&.Mui-disabled": {
              backgroundColor: tokenVar("field-disabled"),
              color: tokenVar("field-disabled-foreground"),
              boxShadow: "none",
            },
            "&.Mui-disabled .MuiOutlinedInput-notchedOutline": { borderColor: tokenVar("field-border") },
            // A disabled multi-line field is usually content to read that the
            // viewer may not change (a template's document), so its text stays
            // readable; the grey fill still says it cannot be edited.
            "&.Mui-disabled.MuiInputBase-multiline .MuiInputBase-input": {
              color: tokenVar("muted-foreground"),
              WebkitTextFillColor: tokenVar("muted-foreground"),
            },
          },
          // A field is 36px tall whatever it holds: 20px of text with 8px
          // above and below, and 12px in from its edge.
          input: {
            fontSize: "0.875rem",
            lineHeight: "20px",
            height: 20,
            padding: "8px 12px",
            // Placeholder text in the muted ink: MUI's 42% black is 2.7:1.
            "&::placeholder": { color: tokenVar("muted-foreground"), opacity: 1 },
          },
          multiline: { padding: "8px 12px" },
          inputMultiline: { padding: 0, height: "auto" },
          adornedStart: { paddingLeft: 12 },
          adornedEnd: { paddingRight: 12 },
          inputAdornedStart: { paddingLeft: 0 },
          inputAdornedEnd: { paddingRight: 0 },
        },
      },
      MuiSvgIcon: { defaultProps: { fontSize: "inherit" } },
      // The switch: a 36x20 pill, ink when on, the field hairline's grey
      // when off, with a canvas-coloured thumb inside it rather than
      // overhanging it. Nested under root so it outranks MUI's size styles.
      MuiSwitch: {
        defaultProps: { size: "small", disableRipple: true },
        styleOverrides: {
          root: ({ theme }) => ({
            width: 36,
            height: 20,
            padding: 0,
            borderRadius: 10,
            // Disabled dims the whole switch, as the design system does, rather than
            // MUI's near-invisible track.
            "&:has(.Mui-disabled)": { opacity: 0.5 },
            // One ring, round the pill, rather than the thumb's own as well.
            "&:has(.Mui-focusVisible)": { outline: `2px solid ${tokenVar("ring")}`, outlineOffset: "2px" },
            "& .MuiSwitch-switchBase": {
              padding: 2,
              "&.Mui-focusVisible": { outline: "none" },
              "&.Mui-checked": {
                transform: "translateX(16px)",
                "& + .MuiSwitch-track": { backgroundColor: tokenVar("primary"), opacity: 1 },
              },
              "&.Mui-disabled + .MuiSwitch-track": { opacity: 1 },
            },
            "& .MuiSwitch-thumb": {
              width: 16,
              height: 16,
              boxShadow: "0 1px 3px rgb(0 0 0 / 0.25)",
              backgroundColor: tokenVar("card"),
            },
            // An off switch is a grey that holds 3:1 against the card, so it
            // can be seen at all; the input grey all but vanishes.
            "& .MuiSwitch-track": {
              borderRadius: 10,
              backgroundColor: `color-mix(in oklch, ${tokenVar("foreground")} 45%, ${tokenVar("card")})`,
              opacity: 1,
            },
            // On, the dark track is light and takes the dark thumb; off, the
            // thumb stays light on the grey.
            ...theme.applyStyles("dark", {
              "& .MuiSwitch-switchBase:not(.Mui-checked) .MuiSwitch-thumb": { backgroundColor: tokenVar("foreground") },
            }),
          }),
        },
      },
      // MUI offsets a label by -11px to take back the padding around its
      // control. The pill has none, so beside a switch that offset pulled
      // the switch out of line and left the label touching it.
      MuiFormControlLabel: {
        styleOverrides: {
          // The design system labels a checkbox or switch the way it labels a field.
          label: { fontSize: "0.875rem", fontWeight: 500 },
          // Weak selectors (`:where`), so a Stack's spacing between the label
          // and what comes before it still applies.
          root: {
            "&:has(> .MuiSwitch-root)": { gap: 8 },
            "&:where(:has(> .MuiSwitch-root):not(.MuiFormControlLabel-labelPlacementStart))": { marginLeft: 0 },
            "&:where(.MuiFormControlLabel-labelPlacementStart:has(> .MuiSwitch-root))": { marginRight: 0 },
          },
        },
      },
      // Underline tabs with a foreground indicator — chrome recedes.
      MuiTabs: {
        styleOverrides: {
          root: { minHeight: 40 },
          indicator: { height: 2, backgroundColor: tokenVar("foreground") },
        },
      },
      MuiTab: {
        styleOverrides: {
          root: {
            minWidth: "auto",
            minHeight: 40,
            padding: "4px 16px 12px",
            fontSize: "0.875rem",
            color: tokenVar("muted-foreground"),
            "&.Mui-selected": { color: tokenVar("foreground"), fontWeight: 500 },
          },
        },
      },
      MuiPopper: { defaultProps: { popperOptions: POPPER_OPTIONS } },
      MuiTextField: { defaultProps: { size: "small", fullWidth: true, variant: "outlined" } },
      // With the label above the box, an empty select would show an empty
      // box; it shows its "" option instead ("All", "None"), where it has one.
      MuiSelect: {
        defaultProps: { displayEmpty: true },
        styleOverrides: { icon: { color: tokenVar("muted-foreground") } },
      },
      MuiTooltip: {
        defaultProps: { arrow: true },
        styleOverrides: {
          tooltip: {
            fontSize: "0.8125rem",
            lineHeight: "1.1rem",
            textAlign: "center",
            borderRadius: RADIUS,
            padding: "8px 12px",
            backgroundColor: tokenVar("foreground"),
            color: tokenVar("background"),
          },
          arrow: { color: tokenVar("foreground") },
        },
      },
    },
  });

export const RADII = { base: RADIUS, lg: RADIUS_LG, xl: RADIUS_XL };
export const ELEVATION = { card: CARD, surface: SURFACE, popover: POPOVER, modal: MODAL };
