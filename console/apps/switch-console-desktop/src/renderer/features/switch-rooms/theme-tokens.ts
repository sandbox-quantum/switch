import {
  cssColorToHex,
  mattermostThemeFromTokens,
  type MattermostTheme,
  type ThemeTokens,
} from '@shared/core/switch-rooms/mattermost-theme';

/** Which CSS custom property backs each token the Mattermost theme needs. */
const TOKEN_VARIABLES: Record<keyof ThemeTokens, string> = {
  background: '--background',
  backgroundElevated: '--background-2',
  backgroundSecondary: '--background-secondary',
  foreground: '--foreground',
  foregroundMuted: '--foreground-muted',
  border: '--border',
  accent: '--primary-button-border',
  // Link and mention text, so it needs a foreground colour: `--selection` is a
  // highlight background and is unreadable as text on the light palette.
  accentStrong: '--foreground-info',
  buttonBg: '--primary-button-background',
  buttonColor: '--primary-button-foreground',
  destructive: '--foreground-destructive',
  warning: '--status-in-progress',
  success: '--status-in-review',
};

/**
 * Resolve the app's live palette to hex.
 *
 * Reading the custom properties directly would hand back their raw text —
 * `var()` chains, or keywords like `white` — so instead each one is applied to
 * an offscreen probe and read back as a computed colour, which the browser has
 * already resolved to a concrete colour function. That also means this follows
 * a theme switch automatically rather than duplicating the palette in TS.
 *
 * Returns null if any token fails to resolve: a partial theme would leave
 * Mattermost with a mix of our colours and its defaults, which looks worse
 * than leaving it alone.
 */
export function readThemeTokens(): ThemeTokens | null {
  if (typeof document === 'undefined') return null;

  const probe = document.createElement('div');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  document.body.appendChild(probe);

  try {
    const resolved: Partial<Record<keyof ThemeTokens, string>> = {};
    for (const [token, variable] of Object.entries(TOKEN_VARIABLES) as [
      keyof ThemeTokens,
      string,
    ][]) {
      probe.style.color = '';
      probe.style.color = `var(${variable})`;
      const hex = cssColorToHex(getComputedStyle(probe).color);
      if (!hex) return null;
      resolved[token] = hex;
    }
    return resolved as ThemeTokens;
  } finally {
    probe.remove();
  }
}

/** The app's current palette as a Mattermost theme, or null if unavailable. */
export function currentMattermostTheme(
  effectiveTheme: 'emlight' | 'emdark'
): MattermostTheme | null {
  const tokens = readThemeTokens();
  if (!tokens) return null;
  return mattermostThemeFromTokens(tokens, effectiveTheme === 'emdark' ? 'dark' : 'light');
}
