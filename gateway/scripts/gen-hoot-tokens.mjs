/* Generates `src/theme/hoot-tokens.ts` from `src/theme/hoot.css`.
 *
 * `hoot.css` is vendored verbatim from the Hoot design system and is the single
 * source of truth for token values. Its colours are authored in oklch, often as
 * var() references to other tokens or color-mix() washes of them, none of which
 * MUI's colour manipulators (alpha/lighten/darken/contrast) can parse, so the
 * palette needs sRGB. This script resolves every colour token per scheme and
 * converts it once, at build time, rather than duplicating the values by hand.
 *
 * Run: npm run gen:tokens
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS_PATH = resolve(HERE, "../src/theme/hoot.css");
const OUT_PATH = resolve(HERE, "../src/theme/hoot-tokens.ts");

/** oklch(L C H [/ A]) -> { L, C, H, alpha }. Throws on anything else. */
function parseOklch(raw) {
  const match = /^oklch\(\s*([^\s)]+)\s+([^\s)]+)\s+([^\s/)]+)\s*(?:\/\s*([^\s)]+)\s*)?\)$/.exec(raw);
  if (!match) throw new Error(`not an oklch() colour: ${raw}`);

  const num = (token) => {
    const value = token.endsWith("%") ? Number(token.slice(0, -1)) / 100 : Number(token);
    if (!Number.isFinite(value)) throw new Error(`unparseable component "${token}" in ${raw}`);
    return value;
  };

  return {
    L: num(match[1]),
    C: num(match[2]),
    H: num(match[3]),
    alpha: match[4] === undefined ? 1 : num(match[4]),
  };
}

/** { L, C, H, alpha } -> "#rrggbb" or "rgba(r, g, b, a)". */
function toSrgb({ L, C, H, alpha }) {
  const h = (H * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;

  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];

  const channels = linear.map((c) => {
    const encoded = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.abs(c) ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(encoded * 255)));
  });

  if (alpha < 1) return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${Number(alpha.toFixed(4))})`;
  return `#${channels.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

const OVERRIDE_SELECTOR = ':root, [data-mui-color-scheme="light"], [data-mui-color-scheme="dark"]';

/** Every top-level block in the file: its selector and its `--hoot-*` declarations. */
function readBlocks(css) {
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks = [];
  for (const match of withoutComments.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const tokens = {};
    for (const decl of match[2].matchAll(/--hoot-([a-z0-9_-]+)\s*:\s*([^;]+);/g)) {
      tokens[decl[1]] = decl[2].replace(/\s+/g, " ").trim();
    }
    blocks.push({ selector: match[1].replace(/\s+/g, " ").trim(), tokens });
  }
  return blocks;
}

/**
 * The tokens <html> carries under each scheme, in cascade order: the light
 * block also matches `:root`, so it applies in both; the dark block overrides
 * it; the theme-independent `:root` blocks come after and win over both; the
 * gateway's overrides, which name every scheme, come last and win over all of
 * them. Outside the overrides, a token declared in more than one block is
 * refused, because which one wins would then rest on source order alone.
 */
function schemeScopes(blocks) {
  const light = blocks.filter((b) => b.selector === ':root, [data-mui-color-scheme="light"]');
  const dark = blocks.filter((b) => b.selector === '[data-mui-color-scheme="dark"]');
  const shared = blocks.filter((b) => b.selector === ":root");
  const overrides = blocks.filter((b) => b.selector === OVERRIDE_SELECTOR);
  if (light.length !== 1 || dark.length !== 1 || shared.length === 0) {
    throw new Error(
      `expected one light block, one dark block and at least one :root block; got ${light.length}, ${dark.length} and ${shared.length}`,
    );
  }
  const unexpected = blocks.filter((b) => ![...light, ...dark, ...shared, ...overrides].includes(b));
  if (unexpected.length > 0) {
    throw new Error(`unexpected selector(s) in hoot.css: ${unexpected.map((b) => b.selector).join(", ")}`);
  }

  const sharedTokens = {};
  for (const block of shared) {
    for (const [name, value] of Object.entries(block.tokens)) {
      if (name in sharedTokens) throw new Error(`--hoot-${name} is declared in two :root blocks`);
      sharedTokens[name] = value;
    }
  }
  for (const scheme of [light[0], dark[0]]) {
    const clash = Object.keys(scheme.tokens).filter((name) => name in sharedTokens);
    if (clash.length > 0) {
      throw new Error(`declared both per scheme and in :root: ${clash.map((n) => `--hoot-${n}`).join(", ")}`);
    }
  }

  const overrideTokens = {};
  for (const block of overrides) {
    for (const [name, value] of Object.entries(block.tokens)) {
      if (!(name in light[0].tokens || name in sharedTokens)) {
        throw new Error(`--hoot-${name} is overridden but upstream does not declare it`);
      }
      overrideTokens[name] = value;
    }
  }

  return {
    light: { ...light[0].tokens, ...sharedTokens, ...overrideTokens },
    dark: { ...light[0].tokens, ...dark[0].tokens, ...sharedTokens, ...overrideTokens },
  };
}

/**
 * A token's value as a colour, following var() references and
 * `color-mix(in oklch, <colour> N%, transparent)` washes. Null for a token
 * that is not a colour (a length, a shadow). Throws on a colour written in a
 * form this script does not resolve, so it can never be silently dropped.
 */
function resolveColour(scope, name, seen = []) {
  if (seen.includes(name)) throw new Error(`var() cycle: ${[...seen, name].map((n) => `--hoot-${n}`).join(" -> ")}`);
  const raw = scope[name];
  if (raw === undefined) throw new Error(`--hoot-${seen.at(-1)} refers to undefined --hoot-${name}`);
  return resolveValue(scope, raw, [...seen, name]);
}

function resolveValue(scope, raw, seen) {
  const ref = /^var\(--hoot-([a-z0-9_-]+)\)$/.exec(raw);
  if (ref) return resolveColour(scope, ref[1], seen);

  const mix = /^color-mix\(in oklch,\s*(.+?)\s+([\d.]+)%,\s*transparent\)$/.exec(raw);
  if (mix) {
    const colour = resolveValue(scope, mix[1], seen);
    if (colour === null) throw new Error(`color-mix() of a non-colour: ${raw}`);
    return { ...colour, alpha: colour.alpha * (Number(mix[2]) / 100) };
  }

  if (raw.startsWith("oklch(")) return parseOklch(raw);
  if (/^(#|rgb|hsl|color|lab|lch|oklab)/.test(raw)) throw new Error(`colour format the generator does not resolve: ${raw}`);
  return null;
}

/** camelCase a kebab token name so it reads naturally in TS. */
const camel = (name) => name.replace(/[-_]([a-z0-9])/g, (_, c) => c.toUpperCase());

function emit(scope) {
  return Object.keys(scope)
    .sort()
    .flatMap((name) => {
      const colour = resolveColour(scope, name);
      return colour === null ? [] : [`  ${camel(name)}: "${toSrgb(colour)}",`];
    })
    .join("\n");
}

/** The contents of `hoot-tokens.ts` for the given `hoot.css`. */
export function generateTokens(css) {
  const scopes = schemeScopes(readBlocks(css));
  const light = emit(scopes.light);
  const dark = emit(scopes.dark);
  const keys = (lines) => lines.split("\n").map((line) => line.split(":")[0]);
  if (keys(light).join() !== keys(dark).join()) {
    throw new Error("the light and dark schemes resolve to different sets of colour tokens");
  }

  return `/* GENERATED by scripts/gen-hoot-tokens.mjs from src/theme/hoot.css — do not edit.
   hoot.css is the source of truth; these are its colour tokens resolved per
   scheme and converted to sRGB, because MUI's palette and colour manipulators
   cannot parse oklch, var() or color-mix().
   Regenerate with: npm run gen:tokens */

export const HOOT_LIGHT = {
${light}
} as const;

export const HOOT_DARK = {
${dark}
} as const;

export type HootColorToken = keyof typeof HOOT_LIGHT;

/** Reference a Hoot token as a live CSS variable (follows the active scheme). */
export const hootVar = (token: string) => \`var(--hoot-\${token})\`;
`;
}

/** What `hoot.css` generates beside the checked-in `hoot-tokens.ts`, read
 *  here because the gateway's tests have no Node types to read them with. */
export function currentTokens() {
  return {
    generated: generateTokens(readFileSync(CSS_PATH, "utf8")),
    checkedIn: readFileSync(OUT_PATH, "utf8"),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(OUT_PATH, generateTokens(readFileSync(CSS_PATH, "utf8")));
  console.log(`wrote ${OUT_PATH}`);
}
