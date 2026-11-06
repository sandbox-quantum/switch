/**
 * The text of a tool call's input and output for the chat (`tool_io`).
 *
 * A part is taken as a terminal shows it (`norm`), redacted (known values and
 * the shared patterns, masked once), then cut to the budget; an input has
 * every string and key normalized, then is serialized and masked once, from
 * what is found in the serialized text and in each of its strings. An input
 * the buffer clipped gets a note. An output the buffer clipped gets a
 * preview: its head and its tail, each kept to its whole lines and redacted
 * on its own, under a note that says the middle was not kept. In every part
 * (a whole output, a preview's head and tail, each string of an input, a
 * server name), private key material is masked by its private armor lines
 * alone: a pair over its span, a lone `BEGIN` to the part's end, a lone `END`
 * from the part's start, so a key cut by the tool (`head -n 5 key.pem`)
 * shows no line of it. In a preview's head and tail, each read on its own,
 * every whole line that holds a long base64 run (a key line, whatever is
 * before or after it on the line) is masked too, under a note; the other
 * lines stay. A server name cut to its budget, and a part a terminal control
 * sequence hid some of, get a note too. The exact string returned is
 * checked for a whole known value form; a hit or any error gives `null`, and
 * the row is sent without a detail.
 */

import {
  PEM_BEGIN_SOURCE,
  PEM_END_SOURCE,
  type SecretRange,
} from '@switch-console/shared/redaction';
import type { ToolDetailParts } from './tool-detail-buffer';
import {
  containsKnownForm,
  isMarker,
  markerRangesOf,
  type Masked,
  maskRanges,
  matchesIn,
  normShown,
  oscMarkAt,
  type Range,
  redactShown,
  type Registry,
  secretRangesIn,
  type Shown,
  viewText,
  withSafeMarkers,
} from './tool-detail-redaction';

/** How many code points the input may take. */
export const TOOL_IO_INPUT_BUDGET = 500;
/** How many code points the whole text may take. */
export const TOOL_IO_BUDGET = 2000;
/** How many code points the MCP server name may take. */
const SERVER_BUDGET = 200;

export const NOTE_NOT_AVAILABLE = 'Detail not available';

type Label = 'Input' | 'Output' | 'Prompt';

const notCaptured = (label: Label) => `${label} — not captured`;
const notReported = (label: Label) => `${label} — not reported by the provider`;
const inputTooLarge = 'Input — too large to show safely in chat.';
const outputClipped = (label: Label, first: number, last: number) =>
  `${label} — clipped: first ${grouped(first)} and last ${grouped(last)} characters shown; the middle was not kept`;
const serverClipped = (shown: number, total: number) =>
  `Server name — first ${grouped(shown)} of ${grouped(total)} characters shown`;
const restHidden = (label: Label | 'Server name') =>
  `${label} — a terminal control sequence with no end hid the rest; it is not shown`;
const cutEscapeHidden = (label: Label) =>
  `${label} — the head ends on an escape the cut left unreadable; the tail is not shown`;
const tailStartHidden = (label: Label) =>
  `${label} — a terminal control sequence terminator was found in the tail; the tail up to it is not shown`;
const keyMaterialHidden = (label: Label) =>
  `${label} — lines that look like part of a private key are not shown`;
const outputNoWholeLine = (label: Label) =>
  `${label} — clipped (more than 8,192 characters), with no whole line at its start or its end to show; nothing is shown. People with access to this agent's Switch Console can open it there.`;

/** The line between a clipped output's head and tail, where the middle was. */
const SKIPPED = '…';
/** What private key material and key lines are masked with, as the shared pattern labels a whole PEM block. */
const PEM_MARKER = '[REDACTED_PEM_BLOCK]';
/** PEM armor lines, as the shared pattern finds them. */
const PEM_BEGIN = new RegExp(PEM_BEGIN_SOURCE, 'g');
const PEM_END = new RegExp(PEM_END_SOURCE, 'g');
/**
 * The labels of key material: a private key of any kind (`PRIVATE KEY`,
 * `RSA PRIVATE KEY`, `OPENSSH PRIVATE KEY`, `ENCRYPTED PRIVATE KEY`…) and
 * `PGP PRIVATE KEY BLOCK`. Only these armor lines open or close a masked range.
 */
const KEY_LABEL = /PRIVATE\s*KEY/i;

/** Text with the positions of the markers in it. */
export interface Marked {
  text: string;
  markerRanges: Range[];
}

/** Cuts a masked text to `budget` code points. */
export type Cutter = (text: string, markerRanges: readonly Range[], budget: number) => Marked;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `ranges` moved `by` code units. */
function shift(ranges: readonly Range[], by: number): Range[] {
  return ranges.map(([from, to]): Range => [from + by, to + by]);
}

function codePoints(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

/** The code unit index after `count` code points of `text`, or its length. */
function unitIndexAfter(text: string, count: number): number {
  let at = 0;
  let seen = 0;
  while (at < text.length && seen < count) {
    const code = text.codePointAt(at)!;
    at += code > 0xffff ? 2 : 1;
    seen++;
  }
  return at;
}

/** `1480` as `1,480`, the same in every locale. */
function grouped(count: number): string {
  return String(count).replace(/\B(?=(\d{3})+$)/g, ',');
}

/**
 * The cut the budget asks for: at the last `\n` within it when that keeps at
 * least half the budget, otherwise at a code point boundary, and never inside
 * a marker. A long one-line field is then shown from its start, not as `{`.
 */
export const cutToBudget: Cutter = (text, markerRanges, budget) => {
  if (codePoints(text) <= budget) return { text, markerRanges: shift(markerRanges, 0) };
  const limit = unitIndexAfter(text, budget);
  const half = unitIndexAfter(text, Math.ceil(budget / 2));
  const newline = text.lastIndexOf('\n', limit - 1);
  let cut = newline > 0 && newline >= half ? newline : limit;
  for (const [from, to] of markerRanges) if (from < cut && cut < to) cut = from;
  const kept = markerRanges.filter(([, to]) => to <= cut);
  return { text: text.slice(0, cut), markerRanges: shift(kept, 0) };
};

/**
 * The cut that keeps the end of a masked text, for a clipped output's tail:
 * at the start of the first line within the last `budget` code points when
 * that keeps at least half the budget, otherwise at a code point boundary,
 * and never inside a marker.
 */
export const cutEndToBudget: Cutter = (text, markerRanges, budget) => {
  const total = codePoints(text);
  if (total <= budget) return { text, markerRanges: shift(markerRanges, 0) };
  const limit = unitIndexAfter(text, total - budget);
  const half = unitIndexAfter(text, total - Math.floor(budget / 2));
  const newline = text.indexOf('\n', limit - 1);
  let cut = newline !== -1 && newline + 1 <= half ? newline + 1 : limit;
  for (const [from, to] of markerRanges) if (from < cut && cut < to) cut = to;
  const kept = markerRanges.filter(([from]) => from >= cut);
  return { text: text.slice(cut), markerRanges: shift(kept, -cut) };
};

/**
 * Whether a clipped output's head ends where a terminal control sequence that
 * may hide what follows may start: on ESC itself, or on ESC written as escaped
 * text (`\u001b`, `\x1b`) or `\u009`, each one character short of an OSC
 * opener. What the dropped middle went on with is not known, so a tail after
 * it cannot be read as a terminal would show it.
 */
function endsAtSequenceStart(head: string): boolean {
  return head.endsWith('\x1b') || /\\(?:u001[bB]|x1[bB]|u009)$/.test(head);
}

/**
 * Where a clipped output's tail that starts inside an OSC string the dropped
 * middle opened ends: after the first terminator (`oscMarkAt`) that comes
 * before any opener, the string's own end as far as the tail can tell; 0 when
 * an opener comes first or there is neither. What is before it belonged to
 * the cut string and cannot be read as a terminal would show it.
 */
function cutSequenceEnd(tail: string): number {
  let at = 0;
  while (at < tail.length) {
    const mark = oscMarkAt(tail, at);
    if (!mark) {
      at++;
      continue;
    }
    return mark.opener ? 0 : mark.end;
  }
  return 0;
}

/**
 * The whole lines of a clipped output's head, as a terminal shows them: the
 * text after its last `\n` is the line the cut went through, so it is
 * dropped; a head with no `\n` keeps nothing. The head is normalized first,
 * so an OSC string it leaves open hides the rest of it (`unterminated`), and
 * a line break inside a sequence `norm` removes is not taken for a line end.
 * `cutEscape` when it ends where a sequence may start (`endsAtSequenceStart`):
 * what that escape began cannot be read, whatever the head held before (a
 * colour code earlier proves nothing about this one). `open` when either is
 * at its end: the tail is then hidden whole.
 */
function headLines(head: string): Shown & { open: boolean; cutEscape: boolean } {
  const shown = normShown(head);
  const end = shown.text.lastIndexOf('\n');
  const cutEscape = !shown.unterminated && endsAtSequenceStart(head);
  return {
    ...shown,
    text: end === -1 ? '' : shown.text.slice(0, end),
    cutEscape,
    open: shown.unterminated || cutEscape,
  };
}

/**
 * The whole lines of a clipped output's tail, as a terminal shows them: the
 * text up to and including its first `\n` is the line the cut went through
 * (or may be: what came before it is not known), so it is dropped; a tail
 * with no `\n` keeps nothing. When the head is `open`, the whole tail is
 * hidden, whatever it holds; the head's note says why. A tail with a
 * terminator before any opener may start inside an OSC string the dropped
 * middle opened, so it is first dropped through that terminator
 * (`cutSequenceEnd`), even when what is before it was plain text. When more
 * than the line the cut went through is not shown, it says which: a sequence
 * with no end hid the rest (`unterminated`), or the tail's start up to that
 * terminator, in more than one line, is not shown (`startHidden`).
 */
function tailLines(tail: string, open: boolean): Shown & { startHidden: boolean } {
  if (open) return { text: '', unterminated: false, startHidden: false };
  const from = cutSequenceEnd(tail);
  const shown = normShown(tail.slice(from));
  const start = shown.text.indexOf('\n');
  return {
    text: start === -1 ? '' : shown.text.slice(start + 1),
    unterminated: shown.unterminated,
    startHidden: /[\n\r]/.test(tail.slice(0, from)),
  };
}

/** A PEM armor line in a part: `BEGIN` or `END`, whether its label is key material, and where it is. */
interface Armor {
  begin: boolean;
  key: boolean;
  start: number;
  end: number;
}

/**
 * The `BEGIN` and `END` lines of PEM blocks in `text`, in order: found in the
 * text and in its search view (`matchesIn`), so a line written with escapes
 * (`-----BEGIN …`) or split by characters a reader does not see counts
 * as the armor line it reads as, and its label is read the same way.
 */
function pemMarkers(text: string): Armor[] {
  const armor =
    (begin: boolean) =>
    ([start, end]: Range): Armor => ({
      begin,
      key: KEY_LABEL.test(viewText(text.slice(start, end))),
      start,
      end,
    });
  return [
    ...matchesIn(text, PEM_BEGIN).map(armor(true)),
    ...matchesIn(text, PEM_END).map(armor(false)),
  ].sort((left, right) => left.start - right.start);
}

/**
 * The private key material of a part (a whole output, the head or the tail
 * of a clipped one, each string of an input, a server name), as ranges to
 * mask, whether its blocks are whole or not. Only private-key armor lines
 * (`KEY_LABEL`) are counted: each private `END` closes the nearest private
 * `BEGIN` before it still open, and the pair is masked from that `BEGIN`
 * through that `END`. A private `END` none closes means the part starts
 * inside a key block (`tail -n 21 key.pem`): masked from the part's start
 * through it. A private `BEGIN` no `END` closes means the part ends inside
 * one (`head -n 21 key.pem`): masked from it to the part's end. An armor
 * line with any other label (`LOG`, `CERTIFICATE`, `PUBLIC KEY`) neither
 * opens nor closes anything, so a public block inside or next to a private
 * one never ends its protection, and a log that opens with
 * `-----BEGIN LOG-----` stays readable. Whole blocks of any label are masked
 * by the shared pattern too.
 */
function privatePemRanges(text: string): SecretRange[] {
  const open: Armor[] = [];
  const ranges: SecretRange[] = [];
  for (const marker of pemMarkers(text)) {
    if (!marker.key) continue;
    if (marker.begin) open.push(marker);
    else ranges.push(pemMask(open.pop()?.start ?? 0, marker.end));
  }
  if (open.length > 0) ranges.push(pemMask(open[0]!.start, text.length));
  return ranges;
}

function pemMask(start: number, end: number): SecretRange {
  return { start, end, marker: PEM_MARKER };
}

/** Only hex digits (`0–9 a–f A–F`): a digest, not a key line. */
const HEX_ONLY = /^[0-9a-fA-F]+$/;
/** One character repeated (`xxxx…`): a filler no key writes. */
const ONE_CHARACTER = /^(.)\1*$/;
/** A run of base64 as long as a line of a key's body, wherever it is on a line. */
const KEY_RUN = /[A-Za-z0-9+/]{40,}={0,2}/g;

/**
 * Whether a run of `KEY_RUN` may be a line of a key's body as PEM and PGP
 * write it: not only hex digits and not one character repeated, once the
 * `=` at its end is left out.
 */
function isKeyLine(run: string): boolean {
  const core = run.replace(/=+$/, '');
  return !HEX_ONLY.test(core) && !ONE_CHARACTER.test(core);
}

/**
 * What a clipped output's head or tail masks besides the known values and
 * the shared patterns: its private key material (`privatePemRanges`), and
 * every whole physical line whose search view (`viewText`, so a line written
 * with escapes or split by characters a reader does not see counts as it
 * reads) holds a run that may be a key line (`isKeyLine`), whatever comes
 * before or after it on the line. What the dropped middle held is not known,
 * so a key the buffer cut shows no line of its body; lines without such a
 * run stay, whatever their neighbours are.
 */
function clippedRanges(text: string): SecretRange[] {
  const ranges = privatePemRanges(text);
  let at = 0;
  for (const line of text.split('\n')) {
    if ([...viewText(line).matchAll(KEY_RUN)].some(([run]) => isKeyLine(run)))
      ranges.push(pemMask(at, at + line.length));
    at += line.length + 1;
  }
  return ranges;
}

/** No known values: the shared patterns alone. */
const NO_KNOWN_VALUES: Pick<Registry, 'forms'> = { forms: [] };

/**
 * `input` with every string and key passed through `norm`, not yet redacted;
 * `hidden.rest` set when an OSC string with no terminator hid the rest of one.
 */
function normalizedInput(input: unknown, hidden: { rest: boolean }): unknown {
  const shown = (text: string) => {
    const each = normShown(text);
    if (each.unterminated) hidden.rest = true;
    return each.text;
  };
  if (typeof input === 'string') return shown(input);
  if (Array.isArray(input)) return input.map((each) => normalizedInput(each, hidden));
  if (!isRecord(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, each]) => [shown(key), normalizedInput(each, hidden)])
  );
}

/** A string (a key or a value) of the serialized input, and where its characters went. */
interface SerializedString {
  /** The string itself, as decoded. */
  value: string;
  /**
   * For each code unit of `value`, where its JSON spelling (`a`, `\n`, `\"`,
   * `\u0001`) starts in the serialized text; last, where the closing quote is.
   */
  at: number[];
}

interface Serialized {
  text: string;
  strings: SerializedString[];
}

/** What `JSON.stringify` leaves out of an object and writes as `null` in an array. */
function isOmitted(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * `value` (strings, numbers, booleans, `null`, arrays and plain records) as
 * `JSON.stringify(value, null, 2)` writes it, with every string in it, keys
 * and values, and where each of its characters went in the text.
 */
function serialize(value: unknown): Serialized {
  let text = '';
  const strings: SerializedString[] = [];
  const writeString = (string: string) => {
    text += '"';
    const at: number[] = [];
    for (let unit = 0; unit < string.length; unit++) {
      at.push(text.length);
      const code = string.charCodeAt(unit);
      if (isHighSurrogate(code) && isLowSurrogate(string.charCodeAt(unit + 1))) {
        // A whole pair is written as it is; a lone surrogate is escaped.
        text += string[unit]!;
        unit++;
        at.push(text.length);
        text += string[unit]!;
      } else text += JSON.stringify(string[unit]!).slice(1, -1);
    }
    at.push(text.length);
    text += '"';
    strings.push({ value: string, at });
  };
  const write = (each: unknown, indent: string): void => {
    if (typeof each === 'string') return writeString(each);
    const inner = `${indent}  `;
    if (Array.isArray(each)) {
      if (each.length === 0) {
        text += '[]';
        return;
      }
      text += '[';
      for (let index = 0; index < each.length; index++) {
        text += `${index > 0 ? ',' : ''}\n${inner}`;
        const item: unknown = each[index];
        if (isOmitted(item)) text += 'null';
        else write(item, inner);
      }
      text += `\n${indent}]`;
      return;
    }
    if (isRecord(each)) {
      const entries = Object.entries(each).filter(([, item]) => !isOmitted(item));
      if (entries.length === 0) {
        text += '{}';
        return;
      }
      text += '{';
      entries.forEach(([key, item], index) => {
        text += `${index > 0 ? ',' : ''}\n${inner}`;
        writeString(key);
        text += ': ';
        write(item, inner);
      });
      text += `\n${indent}}`;
      return;
    }
    const written = JSON.stringify(each) as string | undefined;
    if (written === undefined) throw new Error('The input cannot be serialized.');
    text += written;
  };
  write(value, '');
  return { text, strings };
}

/**
 * The input as it is shown, masked once: every string and key normalized,
 * then written as `JSON.stringify(input, null, 2)` does, and the text masked
 * from the union of two sets of ranges. One is found in the serialized text
 * itself (the known values in their JSON forms, the shared patterns and URL
 * credentials), which sees a key and its value as a pair (`"password": "…"`).
 * The other is found in each string as decoded (the same), so a known value
 * split by a character `norm` removes reads whole whatever spelling JSON gives
 * that character, and a token on the next line of a string is not hidden
 * behind the `n` of `\n`; each is moved to where the string's characters are
 * in the text. Neither is masked before the other is found, so masking a key
 * never hides the pair a pattern finds by it. Outside the masked ranges, the
 * text is `JSON.stringify` of the normalized input. A private key with one
 * armor line in a string is masked within that string (`privatePemRanges`).
 * `hidden.rest` is set when
 * an OSC string with no terminator hid the rest of a string or key.
 */
function maskedInput(
  input: unknown,
  registry: Pick<Registry, 'forms'>,
  hidden: { rest: boolean } = { rest: false }
): Masked {
  const normalized = normalizedInput(input, hidden);
  const { text, strings } = serialize(normalized);
  if (text !== JSON.stringify(normalized, null, 2))
    throw new Error('The input was not serialized as JSON.stringify writes it.');
  const ranges = secretRangesIn(text, registry);
  for (const { value, at } of strings)
    for (const { start, end, marker } of [
      ...secretRangesIn(value, registry),
      ...withSafeMarkers(privatePemRanges(value), registry),
    ])
      ranges.push({ start: at[start]!, end: at[end]!, marker });
  const masked = maskRanges(text, ranges);
  return { text: masked, markerRanges: markerRangesOf(masked) };
}

/**
 * The input as it is shown (with `registry`; by default the shared patterns
 * alone): normalized, serialized and masked once (`maskedInput`).
 */
export function inputText(
  input: unknown,
  registry: Pick<Registry, 'forms'> = NO_KNOWN_VALUES
): string {
  return maskedInput(input, registry).text;
}

/**
 * One block of the text: a note line, a part under its header (cut to the
 * budget), a clipped output's preview (its head and tail, each redacted on
 * its own), or a line shown as it is (already redacted and cut). An input
 * part's `reserve` is what its notes take of its budget.
 */
type Block =
  | { kind: 'note'; text: string }
  | { kind: 'part'; label: Label; masked: Masked; reserve?: number }
  | { kind: 'preview'; label: Label; head: Masked; tail: Masked }
  | { kind: 'line'; marked: Marked };

type Shape = 'codex-mcp' | 'codex-file-change' | 'codex-collab' | 'plain';

/** Which provider shape a detail has, by its type and the keys of its input. */
function shapeOf(detail: ToolDetailParts): Shape {
  const input = detail.input;
  if (!isRecord(input)) return 'plain';
  const keys = Object.keys(input);
  if (
    detail.type === 'mcp_tool_call' &&
    keys.length === 1 &&
    keys[0] === 'server' &&
    typeof input.server === 'string'
  )
    return 'codex-mcp';
  if (
    detail.type === 'file_change' &&
    keys.length === 1 &&
    keys[0] === 'changes' &&
    Array.isArray(input.changes)
  )
    return 'codex-file-change';
  if (detail.type === 'subagent' && ('senderThreadId' in input || 'receiverThreadIds' in input))
    return 'codex-collab';
  return 'plain';
}

/** A part's blocks: the part, then the note for a rest an unterminated OSC string hid, if one did. */
function withHiddenNote(block: Block, label: Label, hidden: boolean): Block[] {
  return hidden ? [block, { kind: 'note', text: restHidden(label) }] : [block];
}

function outputBlocks(detail: ToolDetailParts, label: Label, registry: Registry): Block[] {
  if (!detail.hasOutput)
    return [
      { kind: 'note', text: detail.input === null ? notReported(label) : notCaptured(label) },
    ];
  if (!detail.outputClipped) {
    const shown = normShown(detail.head + detail.tail);
    const masked = redactShown(shown.text, registry, privatePemRanges(shown.text));
    return withHiddenNote({ kind: 'part', label, masked }, label, shown.unterminated);
  }
  const head = headLines(detail.head);
  const tail = tailLines(detail.tail, head.open);
  const headKey = clippedRanges(head.text);
  const tailKey = clippedRanges(tail.text);
  const preview: Block = {
    kind: 'preview',
    label,
    head: redactShown(head.text, registry, headKey),
    tail: redactShown(tail.text, registry, tailKey),
  };
  // What the tail does not show at its start is said before what it does not show at its end.
  const notes: Block[] = [];
  if (headKey.length > 0 || tailKey.length > 0)
    notes.push({ kind: 'note', text: keyMaterialHidden(label) });
  if (tail.startHidden) notes.push({ kind: 'note', text: tailStartHidden(label) });
  if (head.cutEscape) notes.push({ kind: 'note', text: cutEscapeHidden(label) });
  if (head.unterminated || tail.unterminated) notes.push({ kind: 'note', text: restHidden(label) });
  return [preview, ...notes];
}

function inputBlocks(detail: ToolDetailParts, registry: Registry): Block[] {
  if (detail.input === null) return [{ kind: 'note', text: notReported('Input') }];
  if (detail.inputClipped) return [{ kind: 'note', text: inputTooLarge }];
  const hidden = { rest: false };
  const masked = maskedInput(detail.input, registry, hidden);
  // The input's budget holds its notes too, each after a separator.
  const reserve = hidden.rest ? SEPARATOR.length + codePoints(restHidden('Input')) : 0;
  return withHiddenNote({ kind: 'part', label: 'Input', masked, reserve }, 'Input', hidden.rest);
}

const SERVER_PREFIX = 'Server: ';

/**
 * `Server: <name>`, the name normalized and redacted like any part and cut
 * to its budget; a name cut, or one whose rest an OSC string with no
 * terminator hid, gets a note on the next line, as every other part does.
 */
function serverBlock(server: string, registry: Registry): Block {
  const shown = normShown(server);
  const masked = redactShown(shown.text, registry, privatePemRanges(shown.text));
  const cut = cutToBudget(masked.text, masked.markerRanges, SERVER_BUDGET);
  const markerRanges = shift(cut.markerRanges, SERVER_PREFIX.length);
  let note =
    cut.text === masked.text
      ? ''
      : `\n${serverClipped(codePoints(cut.text), codePoints(masked.text))}`;
  if (shown.unterminated) note += `\n${restHidden('Server name')}`;
  return { kind: 'line', marked: { text: `${SERVER_PREFIX}${cut.text}${note}`, markerRanges } };
}

/** The blocks of a detail by provider shape; `null` when nothing can be shown. */
function blocksOf(detail: ToolDetailParts, registry: Registry): Block[] | null {
  if (detail.input === null && !detail.hasOutput && detail.truncated) return null;
  const inputClipped = detail.input !== null && detail.inputClipped;
  const outputClipped = detail.hasOutput && detail.outputClipped;
  // Clipped, but by nothing that names a part: neither part can be trusted.
  if (detail.truncated && !inputClipped && !outputClipped) return null;
  switch (shapeOf(detail)) {
    case 'codex-mcp': {
      // Codex reports only the server, not the arguments, and only an error as
      // output. A server name the buffer clipped gets the note instead, and
      // that note alone stands for the input.
      const server = (detail.input as { server: string }).server;
      const blocks: Block[] = inputClipped
        ? [{ kind: 'note', text: inputTooLarge }]
        : [serverBlock(server, registry), { kind: 'note', text: notReported('Input') }];
      if (detail.hasOutput) blocks.push(...outputBlocks(detail, 'Output', registry));
      return blocks;
    }
    case 'codex-file-change':
      // The input holds the same diffs as the output.
      return outputBlocks(detail, 'Output', registry);
    case 'codex-collab':
      // The thread ids are metadata, not arguments; the text is the prompt sent.
      return outputBlocks({ ...detail, input: null }, 'Prompt', registry);
    case 'plain':
      return [...inputBlocks(detail, registry), ...outputBlocks(detail, 'Output', registry)];
  }
}

const SEPARATOR = '\n\n';

/**
 * The text for `detail`, with `cut` as the budget's cutter. Exported for the
 * tests, which give it a faulty cutter to prove the final check; the host
 * calls `toolIoText`.
 *
 * @internal
 */
export function composeToolIoText(
  detail: ToolDetailParts,
  registry: Registry,
  cut: Cutter
): string | null {
  try {
    const blocks = blocksOf({ ...detail, input: detail.input ?? null }, registry);
    if (blocks === null) return NOTE_NOT_AVAILABLE;
    // Notes, lines and the input first; the output (or prompt) gets what is left.
    const rendered = blocks.map((block): Marked | null => {
      if (block.kind === 'note') return { text: block.text, markerRanges: [] };
      if (block.kind === 'line') return block.marked;
      if (block.kind === 'preview' || block.label !== 'Input') return null;
      // The whole input block, header and notes, within its budget.
      return partWithin(
        block.label,
        block.masked,
        TOOL_IO_INPUT_BUDGET - (block.reserve ?? 0),
        cut
      );
    });
    const used = rendered.reduce(
      (sum, piece) => sum + (piece ? codePoints(piece.text) : 0),
      SEPARATOR.length * (blocks.length - 1)
    );
    const room = TOOL_IO_BUDGET - used;
    blocks.forEach((block, index) => {
      if (rendered[index] !== null) return;
      if (block.kind === 'part') rendered[index] = partWithin(block.label, block.masked, room, cut);
      if (block.kind === 'preview') rendered[index] = previewWithin(block, room, cut);
    });
    let text = '';
    const markerRanges: Range[] = [];
    rendered.forEach((piece, index) => {
      if (!piece) throw new Error('A part was not rendered.');
      if (index > 0) text += SEPARATOR;
      markerRanges.push(...shift(piece.markerRanges, text.length));
      text += piece.text;
    });
    if (codePoints(text) > TOOL_IO_BUDGET) throw new Error('The text is over its budget.');
    // The final check, on the exact string returned: every marker range still
    // holds a whole marker, and no whole known value form is left.
    if (!markerRanges.every(([from, to]) => isMarker(text.slice(from, to)))) return null;
    if (containsKnownForm(text, registry)) return null;
    return text;
  } catch {
    return null;
  }
}

/**
 * A part in `room` code points, header included: whole under its plain
 * header when it fits with it; otherwise cut, with room kept for the longest
 * `first … of …` header it can have.
 */
function partWithin(label: Label, masked: Masked, room: number, cut: Cutter): Marked {
  const total = codePoints(masked.text);
  if (codePoints(`${label}\n`) + total <= room) return withHeader(label, masked, total, cut);
  const all = grouped(total);
  const longest = `${label} — first ${all} of ${all} characters shown\n`;
  return withHeader(label, masked, room - codePoints(longest), cut);
}

/**
 * A clipped output's preview in `room` code points: its note, the head's
 * lines, `…` where the middle was, and the tail's lines. Room is kept for the
 * note's longest form and the `…` line; of what is left, the tail is given
 * up to half and the head the rest, then whatever the head's cut leaves goes
 * to the tail, so neither crowds out the other. The head is cut at its end
 * and the tail at its start, each at a line end where it can be and never
 * inside a marker. With no whole line at either end, only a note.
 */
function previewWithin(
  block: { label: Label; head: Masked; tail: Masked },
  room: number,
  cut: Cutter
): Marked {
  const { label, head, tail } = block;
  if (head.text === '' && tail.text === '')
    return { text: outputNoWholeLine(label), markerRanges: [] };
  const most = Math.max(room, 0);
  const note = codePoints(outputClipped(label, most, most));
  const budget = room - note - '\n'.length - `\n${SKIPPED}\n`.length;
  if (budget < 0) throw new Error('No room is left for a part.');
  const tailShare = Math.min(codePoints(tail.text), Math.floor(budget / 2));
  const first = cut(head.text, head.markerRanges, budget - tailShare);
  const last = cutEndToBudget(tail.text, tail.markerRanges, budget - codePoints(first.text));
  let text = `${outputClipped(label, codePoints(first.text), codePoints(last.text))}\n`;
  const markerRanges: Range[] = [];
  if (first.text !== '') {
    markerRanges.push(...shift(first.markerRanges, text.length));
    text += `${first.text}\n`;
  }
  text += SKIPPED;
  if (last.text !== '') {
    text += '\n';
    markerRanges.push(...shift(last.markerRanges, text.length));
    text += last.text;
  }
  return { text, markerRanges };
}

/** A part under its header: `Input`, or `Input — first X of Y characters shown` when cut. */
function withHeader(label: Label, masked: Masked, budget: number, cut: Cutter): Marked {
  if (budget < 0) throw new Error('No room is left for a part.');
  const body = cut(masked.text, masked.markerRanges, budget);
  const total = codePoints(masked.text);
  const shown = codePoints(body.text);
  const header =
    body.text === masked.text
      ? `${label}\n`
      : `${label} — first ${grouped(shown)} of ${grouped(total)} characters shown\n`;
  return { text: `${header}${body.text}`, markerRanges: shift(body.markerRanges, header.length) };
}

/**
 * The text of a tool call's input and output for the chat, or `null` when it
 * cannot be shown safely: no input the buffer clipped, a clipped output as a
 * preview of its head and tail, every part normalized and redacted, cut to
 * the budget, and the exact text returned checked for a whole known value
 * form. Pure; any error gives `null`.
 */
export function toolIoText(detail: ToolDetailParts, registry: Registry): string | null {
  return composeToolIoText(detail, registry, cutToBudget);
}
