/**
 * Redaction of a tool call's input and output for the chat: the presentation
 * path only. `Redactions` (redaction.ts) keeps scrubbing logs, journals and
 * tool arguments as it does; nothing here changes what a tool runs.
 *
 * A part is shown as a terminal shows it (`norm`), so that is the one text
 * redacted: the occurrences of every form of every known value and the
 * secrets the shared patterns the desktop logger uses
 * (`@switch-console/shared/redaction`) and `scheme://user:password@` find are
 * all searched for in that same text, merged, and masked once, so masking one
 * never hides the key name or scheme another is found by. They are searched
 * for in its search view too (`searchView`), which reads a secret whole that
 * the shown text splits with characters a reader does not see or writes as
 * escapes; what is found there is masked in the shown text, which is
 * otherwise left as it is. The caller checks the exact text it returns for a
 * whole known value form once more, in it and in its view
 * (`containsKnownForm`).
 */

import {
  type RedactionPattern,
  SECRET_PATTERNS,
  type SecretRange,
  secretRanges,
  URL_CREDENTIALS_PATTERN,
} from '@switch-console/shared/redaction';

/** The marker a masked known value is replaced with, as `Redactions` writes it. */
export const MARKER = '[REDACTED]';

/** A `[start, end)` range of UTF-16 code units. */
export type Range = [number, number];

function within(code: number, low: number, high: number): boolean {
  return code >= low && code <= high;
}

/** C0 and C1 controls and DEL, except line feed and tab. */
function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || within(code, 0x7f, 0x9f);
}

/** Bidi controls and zero-width characters. */
function isInvisible(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x180e ||
    code === 0xfeff ||
    within(code, 0x200b, 0x200f) ||
    within(code, 0x202a, 0x202e) ||
    within(code, 0x2060, 0x2064) ||
    within(code, 0x2066, 0x2069)
  );
}

function isHex(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}

/** Where a CSI sequence whose parameters start at `from` ends. */
function csiEnd(text: string, from: number): number {
  let at = from;
  while (at < text.length && within(text.charCodeAt(at), 0x30, 0x3f)) at++;
  while (at < text.length && within(text.charCodeAt(at), 0x20, 0x2f)) at++;
  if (at < text.length && within(text.charCodeAt(at), 0x40, 0x7e)) at++;
  return at;
}

/** The code `\uXXXX` or `\xXX` written at `at` stands for, its length, or `null`. */
export function escapedCode(text: string, at: number): { code: number; length: number } | null {
  if (text[at] !== '\\') return null;
  const digits = text[at + 1] === 'u' ? 4 : text[at + 1] === 'x' ? 2 : 0;
  if (!digits) return null;
  for (let digit = at + 2; digit < at + 2 + digits; digit++) if (!isHex(text[digit])) return null;
  return { code: Number.parseInt(text.slice(at + 2, at + 2 + digits), 16), length: 2 + digits };
}

/** An OSC opener or string terminator found in a text (`oscMarkAt`). */
export interface OscMark {
  opener: boolean;
  /** Where it ends. */
  end: number;
  /** Whether it is written as escaped text (`\u001b]`, `\x07`), not as the character itself. */
  spelled: boolean;
}

/**
 * The OSC opener or string terminator at `at`, as `norm` reads them, or
 * `null` when neither starts there. As characters: an opener is `ESC ]` or
 * U+009D; a terminator is BEL, U+009C (ST) or `ESC \`. Written as escaped
 * text: an opener is `\u001b]`, `\x1b]` or `\u009d` (`\xXX` is read as a
 * control only for ESC, so `\x9d` is text); a terminator is `\u0007`,
 * `\x07`, `\u009c`, `\x9c`, `\u001b\` or `\x1b\`, the last two also with
 * the backslash escaped. The normalization and the scanners of a clipped
 * output's cut read them from here alone, so they agree.
 */
export function oscMarkAt(text: string, at: number): OscMark | null {
  const code = text.charCodeAt(at);
  if (code === 0x9d) return { opener: true, end: at + 1, spelled: false };
  if (code === 0x07 || code === 0x9c) return { opener: false, end: at + 1, spelled: false };
  if (code === 0x1b) {
    const next = text.charCodeAt(at + 1);
    if (next === 0x5d) return { opener: true, end: at + 2, spelled: false };
    if (next === 0x5c) return { opener: false, end: at + 2, spelled: false };
    return null;
  }
  const escaped = escapedCode(text, at);
  if (!escaped) return null;
  const after = at + escaped.length;
  if (escaped.code === 0x1b) {
    if (text[after] === ']') return { opener: true, end: after + 1, spelled: true };
    if (text[after] === '\\') {
      const end = text[after + 1] === '\\' ? after + 2 : after + 1;
      return { opener: false, end, spelled: true };
    }
    return null;
  }
  if (escaped.code === 0x9d && text[at + 1] === 'u')
    return { opener: true, end: after, spelled: true };
  if (escaped.code === 0x07 || escaped.code === 0x9c)
    return { opener: false, end: after, spelled: true };
  return null;
}

/**
 * Where an OSC string whose body starts at `from` ends: after its first
 * terminator written as its opener is (`spelled`). A string opened by the
 * character itself ends only at a real BEL or ST, as a terminal reads it; one
 * written as escaped text is text, which only a terminator written so too
 * ends. -1 when it has none, so it runs to the end of the text.
 */
export function oscStringEnd(text: string, from: number, spelled: boolean): number {
  let at = from;
  while (at < text.length) {
    const mark = oscMarkAt(text, at);
    if (!mark) {
      at++;
      continue;
    }
    if (!mark.opener && mark.spelled === spelled) return mark.end;
    at = mark.end;
  }
  return -1;
}

/**
 * Where a character `norm` removes, written as escaped text at `at`, ends, as
 * JSON, Go or Python print it: `\u001b[…`, `\x1b[…` and `\u009b…` with what
 * follows as a CSI sequence, `\u001b]…`, `\x1b]…` and `\u009d…` with what
 * follows as an OSC string, `\x1b`, `\u00XX` for C0, C1 and DEL other than
 * `\u000a` and `\u0009`, and `\uXXXX` for a bidi control or zero-width
 * character. `at` itself when no such spelling starts there; -1 for an OSC
 * string with no terminator, which runs to the end of the text.
 */
function escapedEnd(text: string, at: number): number {
  const escaped = escapedCode(text, at);
  if (!escaped) return at;
  const { code } = escaped;
  const after = at + escaped.length;
  // `\xXX` only for ESC, as Python and Go print it.
  if (text[at + 1] === 'x' && code !== 0x1b) return at;
  if (code === 0x1b && text[after] === '[') return csiEnd(text, after + 1);
  if (code === 0x1b && text[after] === ']') return oscStringEnd(text, after + 1, true);
  if (code === 0x9b) return csiEnd(text, after);
  if (code === 0x9d) return oscStringEnd(text, after, true);
  return isControl(code) || isInvisible(code) ? after : at;
}

/** A text as a terminal shows it (`norm`). */
export interface Shown {
  text: string;
  /**
   * Whether an OSC string with no terminator took the rest of the input with
   * it, as a terminal hides it: what followed its opener is not in `text`.
   */
  unterminated: boolean;
}

/**
 * `input` as a terminal shows it, and whether an OSC string with no
 * terminator hid the rest of it (`norm`).
 */
export function normShown(input: string): Shown {
  const parts: string[] = [];
  let unterminated = false;
  let at = 0;
  while (at < input.length) {
    const code = input.charCodeAt(at);
    let end = at + 1;
    if (code === 0x1b) {
      const next = input.charCodeAt(at + 1);
      if (next === 0x5b) end = csiEnd(input, at + 2);
      else if (next === 0x5d) end = oscStringEnd(input, at + 2, false);
    } else if (code === 0x9b) end = csiEnd(input, at + 1);
    else if (code === 0x9d) end = oscStringEnd(input, at + 1, false);
    else if (code === 0x5c) {
      // `\\` before a spelling goes with it: a double escape (JSON in JSON)
      // of a character removed leaves no backslash between what it split.
      const doubled = input.charCodeAt(at + 1) === 0x5c ? escapedEnd(input, at + 1) : at + 1;
      const escaped = doubled === -1 || doubled > at + 1 ? doubled : escapedEnd(input, at);
      if (escaped === -1 || escaped > at) end = escaped;
      else parts.push('\\');
    } else if (code === 0x0d) {
      parts.push('\n');
      if (input.charCodeAt(at + 1) === 0x0a) end = at + 2;
    } else if (!isControl(code) && !isInvisible(code)) parts.push(input[at]!);
    if (end === -1) {
      unterminated = true;
      break;
    }
    at = end;
  }
  return { text: parts.join(''), unterminated };
}

/**
 * `input` as a terminal shows it: without CSI and OSC sequences, then without
 * C0 and C1 controls other than `\n` and `\t`, DEL, bidi controls and
 * zero-width characters, with `\r\n` and `\r` as `\n`, and without the same
 * characters written as escaped text, once (`\u200b`) or twice (`\\u200b`).
 * An OSC string ends at a terminator written as its opener is (`oscStringEnd`);
 * one with no such terminator hides the rest of `input`.
 */
export function norm(input: string): string {
  return normShown(input).text;
}

/** The patterns searched for beside the known values: the desktop logger's, and URL credentials. */
const PATTERNS: readonly RedactionPattern[] = [...SECRET_PATTERNS, URL_CREDENTIALS_PATTERN];

/** Every marker the masking writes: ours, and the labelled ones of the shared patterns. */
const MARKERS: readonly string[] = [
  ...new Set([
    MARKER,
    ...PATTERNS.flatMap(([, replacement]) =>
      typeof replacement === 'string' ? (replacement.match(/\[REDACTED[A-Z_]*\]/g) ?? []) : []
    ),
  ]),
];

/** A marker as the masking writes it, ours or a labelled one. */
const MARKER_TEXT = /\[REDACTED(?:_[A-Z]+)*\]/g;

export interface Registry {
  /**
   * Each value, it without the white space around it, and each of its lines
   * of six characters or more with a letter or a digit.
   */
  bases: string[];
  /** Every form a base is searched for in, longest first. */
  forms: string[];
}

/** The shortest line of a value that is a base of its own. */
const LINE_MIN = 6;

function isArmorLine(line: string): boolean {
  return /^-----(?:BEGIN|END) [^\r\n]*-----$/.test(line.trim());
}

/**
 * A value that is a whole marker is outside the registry: it cannot be told
 * apart from the marker that masks it. A value that is only part of a marker
 * is in it and masked like any other; the final check passes over its
 * occurrences inside a marker (`containsKnownForm`).
 */
function isOutsideRegistry(value: string): boolean {
  return value === '' || MARKERS.includes(value) || isArmorLine(value);
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/**
 * The bases of a value: the value, the value without the white space around
 * it (an env file's ` token\n` is printed as `token`), and each of its lines
 * of six characters or more that has a letter or a digit, PEM armor lines and
 * whole markers left out.
 */
function basesOf(value: string): string[] {
  const bases = isOutsideRegistry(value) ? [] : [value];
  const trimmed = value.trim();
  if (trimmed !== value && !isOutsideRegistry(trimmed)) bases.push(trimmed);
  for (const line of value.split(/\r\n|\n|\r/))
    if (
      line !== value &&
      line.length >= LINE_MIN &&
      LETTER_OR_DIGIT.test(line) &&
      !isOutsideRegistry(line)
    )
      bases.push(line);
  return bases;
}

function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * `value` JSON-escaped as Python's `json.dumps` writes it by default
 * (`ensure_ascii`): every character outside printable ASCII, DEL included, as
 * `\uXXXX` with lower-case hex, an astral one as its two surrogates.
 */
function asciiJsonEscape(value: string): string {
  return jsonEscape(value).replace(
    /[^ -~]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
}

/** `encodeURIComponent` and its variants: lower-case hex, `+` for a space, `/` left as it is. */
function urlForms(value: string): string[] {
  let encoded: string;
  try {
    encoded = encodeURIComponent(value);
  } catch {
    return [];
  }
  const forms: string[] = [];
  for (const slash of [false, true])
    for (const plus of [false, true])
      for (const lower of [false, true]) {
        let form = slash ? encoded.replace(/%2F/g, '/') : encoded;
        if (plus) form = form.replace(/%20/g, '+');
        if (lower) form = form.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
        forms.push(form);
      }
  return forms;
}

/**
 * The forms a base is searched for in the shown text: as it is, JSON-escaped
 * (as `JSON.stringify` and as Python's `json.dumps` write it) and URL-encoded,
 * each also as `norm` shows it, and the JSON escapes of its `norm` (how a
 * normalized input string is serialized).
 */
function formsOf(base: string): string[] {
  const written = [base, jsonEscape(base), asciiJsonEscape(base), ...urlForms(base)];
  const shown = norm(base);
  return [...written, ...written.map(norm), jsonEscape(shown), asciiJsonEscape(shown)];
}

/**
 * The registry of known values for one report: the bases and every form they
 * are searched for in. Built again for every report, so a value added since
 * is in it.
 */
export function buildRegistry(values: readonly string[]): Registry {
  const bases = new Set<string>();
  const forms = new Set<string>();
  for (const value of values)
    for (const base of basesOf(value)) {
      bases.add(base);
      for (const form of formsOf(base)) if (!isOutsideRegistry(form)) forms.add(form);
    }
  return {
    bases: [...bases],
    forms: [...forms].sort((left, right) => right.length - left.length),
  };
}

/**
 * `ranges` merged where they overlap or touch. A merged range keeps the
 * marker of the ranges in it when they all have the same one (a token the
 * shared patterns label); any other gets ours.
 */
function union(ranges: readonly SecretRange[]): SecretRange[] {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: SecretRange[] = [];
  for (const { start, end, marker } of sorted) {
    const last = merged.at(-1);
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      if (last.marker !== marker) last.marker = MARKER;
    } else merged.push({ start, end, marker });
  }
  return merged;
}

/** `text` with each range replaced with its marker, overlapping ones together. */
export function maskRanges(text: string, ranges: readonly SecretRange[]): string {
  if (!ranges.length) return text;
  const parts: string[] = [];
  let cursor = 0;
  for (const { start, end, marker } of union(ranges)) {
    parts.push(text.slice(cursor, start), marker);
    cursor = end;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

/** Every occurrence of every form in `text`, with our marker. */
function knownRanges(text: string, registry: Pick<Registry, 'forms'>): SecretRange[] {
  const ranges: SecretRange[] = [];
  for (const form of registry.forms)
    for (let at = text.indexOf(form); at !== -1; at = text.indexOf(form, at + 1))
      ranges.push({ start: at, end: at + form.length, marker: MARKER });
  return ranges;
}

/**
 * `text` masked once: the occurrences of the known values and the secrets
 * the shared patterns and URL credentials find, in `text` itself and in its
 * search view, merged.
 */
export function maskSecrets(text: string, registry: Pick<Registry, 'forms'>): string {
  return maskRanges(text, secretRangesIn(text, registry));
}

const DEFAULT_IGNORABLE = /^\p{Default_Ignorable_Code_Point}$/u;

/**
 * Whether the search view leaves out the code point `code`: C0 and C1
 * controls and DEL other than `\n` and `\t`, every default-ignorable code
 * point (soft hyphen, fillers, variation selectors, tag characters, zero-width
 * and bidi controls…), and the interlinear annotation characters
 * U+FFF9–U+FFFB, which have no glyph either but are not default-ignorable.
 * None of them is seen by a reader.
 */
function isUnseen(code: number): boolean {
  return (
    isControl(code) ||
    within(code, 0xfff9, 0xfffb) ||
    (code >= 0xad && DEFAULT_IGNORABLE.test(String.fromCodePoint(code)))
  );
}

function isSurrogate(code: number, low: number): boolean {
  return within(code, low, low + 0x3ff);
}

/**
 * The code `\uXXXX` or `\xXX` at `at` stands for, also with `\\` before it (a
 * double escape), and where it ends; `null` when none starts there.
 */
function spelledUnit(text: string, at: number): { code: number; end: number } | null {
  const backslash = text[at] === '\\' && text[at + 1] === '\\' ? at + 1 : at;
  const escaped = escapedCode(text, backslash);
  return escaped && { code: escaped.code, end: backslash + escaped.length };
}

/**
 * The code point a `\uXXXX` or `\xXX` spelling at `at` stands for (a
 * surrogate pair as two `\uXXXX`, the second also after `\\`), with `\\`
 * before it, and where it ends; `null` for none, or for a lone surrogate.
 */
function spelledCodePoint(text: string, at: number): { code: number; end: number } | null {
  const first = spelledUnit(text, at);
  if (first === null) return null;
  if (!isSurrogate(first.code, 0xd800) && !isSurrogate(first.code, 0xdc00)) return first;
  const second = isSurrogate(first.code, 0xd800) ? spelledUnit(text, first.end) : null;
  if (second === null || !isSurrogate(second.code, 0xdc00)) return null;
  return {
    code: 0x10000 + ((first.code - 0xd800) << 10) + (second.code - 0xdc00),
    end: second.end,
  };
}

/** A text to search in, and for each of its code units the range of the source it came from. */
export interface View {
  text: string;
  from: number[];
  to: number[];
}

/** `text` without what a reader does not see (`isUnseen`), each code unit with where it is in `text`. */
function seenOnly(text: string): View {
  const parts: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  while (at < text.length) {
    const code = text.codePointAt(at)!;
    const end = at + (code > 0xffff ? 2 : 1);
    if (!isUnseen(code)) {
      parts.push(text.slice(at, end));
      for (let unit = at; unit < end; unit++) {
        from.push(at);
        to.push(end);
      }
    }
    at = end;
  }
  return { text: parts.join(''), from, to };
}

/**
 * The search view of `text`, used only to find secrets: `text` without what a
 * reader does not see (`isUnseen`), then with every `\uXXXX` and `\xXX`
 * spelling (`spelledCodePoint`) read as the character it stands for, one a
 * reader does not see left out, and JSON's escaped solidus `\/` read as `/`.
 * Unseen characters go first, so however many of them are inside a spelling,
 * it is still read. A backslash that starts no spelling stays, as it is shown.
 * Each code unit of the view keeps the whole source range it came from (a
 * character, or a whole spelling with the unseen characters inside it), so a
 * range found in the view masks whole spellings. Two passes, each linear in
 * the length of `text`.
 */
export function searchView(text: string): View {
  const seen = seenOnly(text);
  const source = seen.text;
  const parts: string[] = [];
  const from: number[] = [];
  const to: number[] = [];
  let at = 0;
  while (at < source.length) {
    let code: number;
    let end: number;
    if (source[at] === '\\') {
      const spelled =
        source[at + 1] === '/' ? { code: 0x2f, end: at + 2 } : spelledCodePoint(source, at);
      ({ code, end } = spelled ?? { code: 0x5c, end: at + 1 });
    } else {
      code = source.codePointAt(at)!;
      end = at + (code > 0xffff ? 2 : 1);
    }
    if (!isUnseen(code)) {
      const char = String.fromCodePoint(code);
      parts.push(char);
      for (let unit = 0; unit < char.length; unit++) {
        from.push(seen.from[at]!);
        to.push(seen.to[end - 1]!);
      }
    }
    at = end;
  }
  return { text: parts.join(''), from, to };
}

/** The search view of `text` (`searchView`), as text alone: what a reader reads it as. */
export function viewText(text: string): string {
  return searchView(text).text;
}

/** `ranges` found in `view`, each on the whole source units it came from; empty ones left out. */
function rangesOnSource(view: View, ranges: readonly SecretRange[]): SecretRange[] {
  return ranges
    .filter(({ start, end }) => end > start)
    .map(({ start, end, marker }) => ({
      start: view.from[start]!,
      end: view.to[end - 1]!,
      marker,
    }));
}

/**
 * Whether a range of `text` lies outside every marker the masking writes
 * (`MARKERS`) that is already in `text`: a value that is part of one, such as
 * `TOKEN` in `[REDACTED_GITHUB_TOKEN]`, is passed over there, so a marker is
 * never cut into another. A look-alike such as `[REDACTED_SECRET]` does not
 * count.
 */
function outsideMarkersOf(text: string): (range: SecretRange) => boolean {
  const markers = markerRangesOf(text).filter(([from, to]) =>
    MARKERS.includes(text.slice(from, to))
  );
  if (!markers.length) return () => true;
  // For each position inside a marker, where that marker ends.
  const markerEnd = new Int32Array(text.length).fill(-1);
  for (const [from, to] of markers) markerEnd.fill(to, from, to);
  return ({ start, end }) => start >= text.length || markerEnd[start]! < end;
}

/** What `find` finds in `text` and in its search view `view`, moved onto `text`. */
function foundIn(text: string, view: View, find: (text: string) => SecretRange[]): SecretRange[] {
  const ranges = find(text);
  if (view.text !== text) ranges.push(...rangesOnSource(view, find(view.text)));
  return ranges;
}

/**
 * Where `pattern` (a global expression) matches in `text` and in its search
 * view (moved onto `text`), in order, overlapping matches as one: so an armor
 * line written with escapes or split by characters a reader does not see is
 * found where it is shown.
 */
export function matchesIn(text: string, pattern: RegExp): Range[] {
  const find = (each: string): SecretRange[] =>
    [...each.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
      marker: MARKER,
    }));
  const found = foundIn(text, searchView(text), find).sort(
    (left, right) => left.start - right.start
  );
  const merged: Range[] = [];
  for (const { start, end } of found) {
    const last = merged.at(-1);
    if (last && start < last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * The occurrences of the known values in `text` and in its search view,
 * other than inside a marker already in `text`.
 */
function knownRangesIn(text: string, view: View, registry: Pick<Registry, 'forms'>): SecretRange[] {
  return foundIn(text, view, (each) => knownRanges(each, registry)).filter(outsideMarkersOf(text));
}

/**
 * Where `maskSecrets` would mask `text`: the occurrences of the known values
 * and the secrets the shared patterns and URL credentials find, in `text`
 * and in its search view (moved onto `text`), not yet merged, so a caller can
 * add ranges of its own and mask once. A labelled marker that holds a known
 * value form (a password that is `GITHUB`) would show it, so a secret it
 * labels gets our marker instead.
 */
export function secretRangesIn(text: string, registry: Pick<Registry, 'forms'>): SecretRange[] {
  const view = searchView(text);
  const patterns = foundIn(text, view, (each) => secretRanges(each, PATTERNS));
  return [...knownRangesIn(text, view, registry), ...withSafeMarkers(patterns, registry)];
}

/**
 * `ranges` with each labelled marker that holds a known value form (a
 * password that is `GITHUB`, or `PEM`) replaced with our plain one, so the
 * marker never shows it. Every range masked with a marker of its own goes
 * through here: the shared patterns' and a caller's (a lone PEM armor line).
 */
export function withSafeMarkers(
  ranges: readonly SecretRange[],
  registry: Pick<Registry, 'forms'>
): SecretRange[] {
  const showsForm = new Map<string, boolean>();
  const markerOf = (marker: string) => {
    if (!showsForm.has(marker))
      showsForm.set(
        marker,
        registry.forms.some((form) => marker.includes(form))
      );
    return showsForm.get(marker) ? MARKER : marker;
  };
  return ranges.map((range) => ({ ...range, marker: markerOf(range.marker) }));
}

/** Where the markers in `text` are, ours and the labelled ones. */
export function markerRangesOf(text: string): Range[] {
  return [...text.matchAll(MARKER_TEXT)].map((match): Range => [
    match.index,
    match.index + match[0].length,
  ]);
}

/** Whether `text` is one whole marker, ours or a labelled one. */
export function isMarker(text: string): boolean {
  return /^\[REDACTED(?:_[A-Z]+)*\]$/.test(text);
}

export interface Masked {
  /** The text to show. */
  text: string;
  /** Where in `text` the markers are, so a cut never splits one. */
  markerRanges: Range[];
}

/**
 * `shown` (text already as `norm` gives it) redacted: the known values, the
 * shared patterns and URL credentials, and the caller's own `extra` ranges,
 * masked once; every marker chosen as `withSafeMarkers` chooses it.
 */
export function redactShown(
  shown: string,
  registry: Pick<Registry, 'forms'>,
  extra: readonly SecretRange[] = []
): Masked {
  const ranges = [...secretRangesIn(shown, registry), ...withSafeMarkers(extra, registry)];
  const text = maskRanges(shown, ranges);
  return { text, markerRanges: markerRangesOf(text) };
}

/** `raw` as a terminal shows it, redacted. */
export function redactText(raw: string, registry: Pick<Registry, 'forms'>): Masked {
  return redactShown(norm(raw), registry);
}

/**
 * Whether `text` still holds a whole form of a known value, in it or in its
 * search view, other than inside a marker the masking writes, as
 * `secretRangesIn` passes over it.
 */
export function containsKnownForm(text: string, registry: Pick<Registry, 'forms'>): boolean {
  return knownRangesIn(text, searchView(text), registry).length > 0;
}
