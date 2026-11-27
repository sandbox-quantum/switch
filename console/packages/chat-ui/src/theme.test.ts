import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Console defines these names in its own CSS; the web dashboard has only theme.css.
// A var() it lacks voids the whole declaration there, and a colour name it lacks
// makes Tailwind emit no utility at all, so the style silently vanishes on the web.
const webTheme = readFileSync(join(__dirname, 'theme.css'), 'utf8');

const SET_AT_RUNTIME: Record<string, string> = {
  '--gap': 'ToggleGroup sets it inline from its spacing',
  '--anchor-width': 'Base UI sets it on a positioned popup',
  '--available-height': 'Base UI sets it on a positioned popup',
  '--transform-origin': 'Base UI sets it on a positioned popup',
  '--modal-chrome': "Console's modal layout sets it inline, and the read carries a fallback",
};

const sources = readdirSync(__dirname, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.(tsx?|css)$/.test(file) && !/\.test\.tsx?$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(__dirname, file), 'utf8') }));

const defined = (name: string) => new RegExp(`(^|[^\\w-])${name}\\s*:`, 'm').test(webTheme);

function missing(pattern: RegExp, toName: (match: string) => string | null): string[] {
  const gaps = new Set<string>();
  for (const { file, text } of sources) {
    for (const [, match] of text.matchAll(pattern)) {
      const name = toName(match!);
      if (name && !defined(name)) gaps.add(`${name} (${file})`);
    }
  }
  return [...gaps].sort();
}

describe('the web theme', () => {
  it('defines every variable the shared UI reads', () => {
    // `var(--x)` and Tailwind's `bg-(--x)` shorthand.
    const gaps = missing(/(?:var\(|-\()(--[\w-]+)/g, (name) =>
      // The dashboard's own tokens, which theme.css maps from.
      name.startsWith('--sw-') || name in SET_AT_RUNTIME ? null : name
    );
    expect(gaps).toEqual([]);
  });

  it("defines every Switch colour name the shared UI's classes use", () => {
    const gaps = missing(
      /(?<![\w-])(?:bg|text|border(?:-[trblxyse])?|ring|outline|fill|stroke|divide|from|via|to|accent|caret|decoration|placeholder|shadow)-((?:background|foreground|border|primary|destructive|muted|input|ring)(?:-[a-z0-9]+)*)(?:\/\d+)?(?![\w-])/g,
      (name) => `--color-${name}`
    );
    expect(gaps).toEqual([]);
  });
});
