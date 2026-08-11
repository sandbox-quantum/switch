import { describe, expect, it } from 'vitest';
import { cssColorToHex, displayP3ToHex, mattermostThemeFromTokens } from './mattermost-theme';

describe('displayP3ToHex', () => {
  it('maps the endpoints exactly', () => {
    expect(displayP3ToHex(0, 0, 0)).toBe('#000000');
    expect(displayP3ToHex(1, 1, 1)).toBe('#ffffff');
  });

  it('leaves greys untouched, since the conversion rows sum to 1', () => {
    // Switch Console's neutral scale is achromatic, so this is the property that
    // lets the palette survive the gamut change unchanged.
    expect(displayP3ToHex(0.067, 0.067, 0.067)).toBe('#111111');
    expect(displayP3ToHex(0.988, 0.988, 0.988)).toBe('#fcfcfc');
  });

  it('actually moves a saturated colour, rather than passing it through', () => {
    // jade-9 (dark). A naive read would give #51a085; P3 is the wider gamut, so
    // the sRGB equivalent has to be more saturated to look the same.
    const converted = displayP3ToHex(0.319, 0.63, 0.521);
    expect(converted).not.toBe('#51a085');
    expect(converted).toMatch(/^#[0-9a-f]{6}$/);
  });

  it('clips out-of-gamut colours instead of producing garbage', () => {
    // Pure P3 red is outside sRGB; every channel must still be a valid byte.
    expect(displayP3ToHex(1, 0, 0)).toMatch(/^#[0-9a-f]{6}$/);
    expect(displayP3ToHex(1, 0, 0).startsWith('#ff')).toBe(true);
  });
});

describe('cssColorToHex', () => {
  it('parses the color(display-p3 ...) form the palette computes to', () => {
    expect(cssColorToHex('color(display-p3 0.067 0.067 0.067)')).toBe('#111111');
  });

  it('parses rgb(), which is what keyword tokens like `white` resolve to', () => {
    expect(cssColorToHex('rgb(255, 255, 255)')).toBe('#ffffff');
    expect(cssColorToHex('rgba(17, 17, 17, 1)')).toBe('#111111');
  });

  it('accepts space-separated rgb', () => {
    expect(cssColorToHex('rgb(0 128 255)')).toBe('#0080ff');
  });

  it('passes hex through, expanding shorthand', () => {
    expect(cssColorToHex('#AABBCC')).toBe('#aabbcc');
    expect(cssColorToHex('#abc')).toBe('#aabbcc');
  });

  it('returns null for anything it does not understand, rather than guessing', () => {
    expect(cssColorToHex('color-mix(in srgb, red, blue)')).toBeNull();
    expect(cssColorToHex('')).toBeNull();
    expect(cssColorToHex('transparent')).toBeNull();
  });
});

describe('mattermostThemeFromTokens', () => {
  const tokens = {
    background: '#111111',
    backgroundElevated: '#222222',
    backgroundSecondary: '#191919',
    foreground: '#eeeeee',
    foregroundMuted: '#b4b4b4',
    border: '#3a3a3a',
    accent: '#51a085',
    accentStrong: '#66d4a7',
    buttonBg: '#1d3a2e',
    buttonColor: '#bbeed6',
    destructive: '#e5484d',
    warning: '#f5a524',
    success: '#30a46c',
  };

  it('marks the theme custom, or Mattermost ignores the colours', () => {
    expect(mattermostThemeFromTokens(tokens, 'dark').type).toBe('custom');
  });

  it('drives the channel surface from the app background', () => {
    const theme = mattermostThemeFromTokens(tokens, 'dark');
    expect(theme.centerChannelBg).toBe('#111111');
    expect(theme.centerChannelColor).toBe('#eeeeee');
  });

  it('picks a code theme per mode, since that key is a name not a colour', () => {
    expect(mattermostThemeFromTokens(tokens, 'dark').codeTheme).toBe('monokai');
    expect(mattermostThemeFromTokens(tokens, 'light').codeTheme).toBe('github');
  });

  it('emits only strings, which is all the preferences API accepts', () => {
    const theme = mattermostThemeFromTokens(tokens, 'dark');
    for (const value of Object.values(theme)) expect(typeof value).toBe('string');
  });
});
