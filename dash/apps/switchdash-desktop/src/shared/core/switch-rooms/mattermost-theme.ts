/**
 * Build a Mattermost theme from switchdash's own design tokens, so the embedded
 * room view matches the app instead of sitting in it as a bright rectangle.
 *
 * Mattermost accepts a fully custom theme as a per-user preference, which is
 * better than overriding its stylesheet from the guest preload: it themes
 * itself, so hovers, menus, code blocks and states we never enumerated stay
 * coherent rather than half-converted.
 */

/** The subset of Mattermost theme keys that matter once the chrome is hidden. */
export type MattermostTheme = Record<string, string>;

/** sRGB transfer function, and its inverse. */
function gammaExpand(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function gammaEncode(c: number): number {
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

/**
 * Linear Display-P3 to linear sRGB (D65, no chromatic adaptation needed since
 * both use the same white point).
 *
 * Each row sums to 1, so achromatic colours are unchanged — which is why
 * switchdash's greys convert to the same hex either way, and only the accent
 * colours actually move.
 */
const P3_TO_SRGB = [
  [1.2249401762805, -0.2249401762805, 0.0],
  [-0.0420569547775, 1.0420569547775, 0.0],
  [-0.0196376254397, -0.0786361771772, 1.0982738026169],
] as const;

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

function toHexPair(unit: number): string {
  return Math.round(clamp01(unit) * 255)
    .toString(16)
    .padStart(2, '0');
}

/**
 * Convert a Display-P3 triple (0–1 components) to an sRGB hex string.
 *
 * P3 is the wider gamut, so saturated colours can land outside sRGB and are
 * clipped per channel. That is a visible but unavoidable approximation on an
 * sRGB surface, and it only affects the accent colours.
 */
export function displayP3ToHex(r: number, g: number, b: number): string {
  const linear = [gammaExpand(r), gammaExpand(g), gammaExpand(b)];
  const out = P3_TO_SRGB.map((row) =>
    gammaEncode(clamp01(row[0] * linear[0] + row[1] * linear[1] + row[2] * linear[2]))
  );
  return `#${out.map(toHexPair).join('')}`;
}

/**
 * Normalise a computed CSS colour to hex.
 *
 * Reading these off a probe element rather than the custom property itself
 * means the browser has already resolved `var()` chains and keywords, so the
 * input is always a concrete colour function — but which one depends on the
 * token (`color(display-p3 …)` for the palette, `rgb(…)` for plain keywords
 * like `white`).
 *
 * Returns null for anything unrecognised, so a caller can drop that key rather
 * than emit a broken theme.
 */
export function cssColorToHex(value: string): string | null {
  const input = value.trim();

  const p3 = /^color\(\s*display-p3\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+([\d.eE+-]+)/.exec(input);
  if (p3) {
    return displayP3ToHex(Number(p3[1]), Number(p3[2]), Number(p3[3]));
  }

  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(input);
  if (rgb) {
    const parts = [rgb[1], rgb[2], rgb[3]].map((n) => toHexPair(Number(n) / 255));
    return `#${parts.join('')}`;
  }

  if (/^#[0-9a-f]{6}$/i.test(input)) return input.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(input)) {
    const [, a, b, c] = input.toLowerCase();
    return `#${a}${a}${b}${b}${c}${c}`;
  }

  return null;
}

/**
 * switchdash tokens the theme is built from, already resolved to hex. Kept as
 * an explicit shape so the renderer's collection and this mapping cannot drift
 * apart silently.
 */
export type ThemeTokens = {
  background: string;
  backgroundElevated: string;
  backgroundSecondary: string;
  foreground: string;
  foregroundMuted: string;
  border: string;
  accent: string;
  accentStrong: string;
  buttonBg: string;
  buttonColor: string;
  destructive: string;
  warning: string;
  success: string;
};

/**
 * Map switchdash tokens onto Mattermost's theme keys.
 *
 * Sidebar keys are still set even though the sidebars are hidden: Mattermost
 * reuses those colours in menus and popovers that remain visible.
 */
export function mattermostThemeFromTokens(
  tokens: ThemeTokens,
  mode: 'light' | 'dark'
): MattermostTheme {
  return {
    type: 'custom',

    sidebarBg: tokens.backgroundSecondary,
    sidebarText: tokens.foreground,
    sidebarUnreadText: tokens.foreground,
    sidebarTextHoverBg: tokens.backgroundElevated,
    sidebarTextActiveBorder: tokens.accent,
    sidebarTextActiveColor: tokens.foreground,
    sidebarHeaderBg: tokens.backgroundSecondary,
    sidebarHeaderTextColor: tokens.foreground,

    centerChannelBg: tokens.background,
    centerChannelColor: tokens.foreground,
    newMessageSeparator: tokens.accent,
    linkColor: tokens.accentStrong,

    buttonBg: tokens.buttonBg,
    buttonColor: tokens.buttonColor,

    mentionBg: tokens.accent,
    mentionColor: tokens.background,
    mentionHighlightBg: tokens.backgroundElevated,
    mentionHighlightLink: tokens.accentStrong,

    errorTextColor: tokens.destructive,
    onlineIndicator: tokens.success,
    awayIndicator: tokens.warning,
    dndIndicator: tokens.destructive,

    // Mattermost only accepts its own named code themes, not colours.
    codeTheme: mode === 'dark' ? 'monokai' : 'github',
  };
}
