import { redactSecretsAndUrlCredentials } from '@switch-console/shared/redact-secrets';
import type { Redactions } from './redaction';
import {
  TOOL_INPUT_LIMIT,
  TOOL_INPUT_STRING_LIMIT,
  type ToolDetailParts,
} from './tool-detail-buffer';

/**
 * The redacted, capped copy of one tool call's input and output that goes to
 * Switch on the call's activity row, and only there. Switch keeps it only for
 * a room whose owner switched tool detail on; a host sends it regardless and
 * leaves that decision to Switch.
 *
 * What the buffer holds of a long output is its head and its tail, the middle
 * dropped. A secret that straddled either cut is in the buffer only in part,
 * and a part matches no pattern and no exact value. So each kept part is
 * redacted on its own, and the partial line at each cut is dropped before it
 * is: whatever a cut split leaves nothing behind. The same goes for an input
 * string the buffer clipped.
 *
 * A private key is the one secret that dropping a line does not cover: it is
 * many whole lines, and the pattern for it needs both its BEGIN and its END. A
 * block still open where a part ends, or closing where a part starts, is
 * masked up to that cut.
 */

/** As much as Switch takes (`MAX_TOOL_DETAIL_CHARS` in core). */
export const TOOL_DETAIL_PREVIEW = 2000;
/** The input's share of it, so a long command leaves room for what it printed. */
export const TOOL_DETAIL_INPUT = 500;

const OUTPUT_GAP = '… (the middle of the output was not kept) …';
const CLIPPED_INPUT = ' … (clipped)';
const PEM_BEGIN = '-----BEGIN';
const PEM_END = '-----END';
const PEM_MASK = '[REDACTED_PEM_BLOCK]';

/** Exact values first, then what a credential looks like. */
function redact(text: string, redactions: Redactions | null): string {
  return redactSecretsAndUrlCredentials(redactions ? redactions.text(text) : text);
}

/** `text` up to its last whole line: the line a cut ran through is dropped. */
function beforeLastLine(text: string): string {
  const end = text.lastIndexOf('\n');
  return end < 0 ? '' : text.slice(0, end);
}

/** `text` from its first whole line: the line a cut ran through is dropped. */
function afterFirstLine(text: string): string {
  const start = text.indexOf('\n');
  return start < 0 ? '' : text.slice(start + 1);
}

/** Text that ends at a cut, with a key block the cut left open masked to the end. */
function closeOpenKey(text: string): string {
  const begin = text.lastIndexOf(PEM_BEGIN);
  if (begin < 0 || text.lastIndexOf(PEM_END) > begin) return text;
  return `${text.slice(0, begin)}${PEM_MASK}`;
}

/** Text that starts at a cut, with a key block closing in it masked from the start. */
function openClosingKey(text: string): string {
  const end = text.indexOf(PEM_END);
  if (end < 0) return text;
  const begin = text.indexOf(PEM_BEGIN);
  if (begin >= 0 && begin < end) return text;
  const lineEnd = text.indexOf('\n', end);
  return `${PEM_MASK}${lineEnd < 0 ? '' : text.slice(lineEnd)}`;
}

/**
 * A string the buffer clipped ends in `…` exactly one past its limit. Its last
 * word is the one the clip ran through, so it goes, the same as a cut line.
 */
function unclip(text: string, limit: number): string {
  if (text.length !== limit + 1 || !text.endsWith('…')) return text;
  const kept = text.slice(0, limit);
  const end = Math.max(kept.lastIndexOf(' '), kept.lastIndexOf('\n'), kept.lastIndexOf('\t'));
  return `${closeOpenKey(end < 0 ? '' : kept.slice(0, end))}${CLIPPED_INPUT}`;
}

function unclipValue(value: unknown): unknown {
  if (typeof value === 'string') return unclip(value, TOOL_INPUT_STRING_LIMIT);
  if (Array.isArray(value)) return value.map(unclipValue);
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, unclipValue(each)]));
  return value;
}

/** A command reads as the command; anything else as its arguments. */
function inputText(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'string') return unclip(input, TOOL_INPUT_LIMIT);
  const whole = unclipValue(input);
  if (
    typeof whole === 'object' &&
    whole !== null &&
    !Array.isArray(whole) &&
    typeof (whole as Record<string, unknown>).command === 'string' &&
    Object.keys(whole).length === 1
  )
    return `$ ${(whole as Record<string, string>).command}`;
  const text = JSON.stringify(whole);
  return text === undefined || text === '{}' ? null : text;
}

function outputText(parts: ToolDetailParts, redactions: Redactions | null): string | null {
  if (!parts.hasOutput) return null;
  if (!parts.outputClipped) return redact(parts.head + parts.tail, redactions);
  const head = redact(closeOpenKey(beforeLastLine(parts.head)), redactions);
  const tail = redact(openClosingKey(afterFirstLine(parts.tail)), redactions);
  return [head, OUTPUT_GAP, tail].filter((part) => part.length > 0).join('\n');
}

/** Cut to `limit`, saying what was left out. Only ever cuts redacted text. */
function capped(text: string, limit: number, what: string): string {
  if (text.length <= limit) return text;
  const note = (left: number) => `\n[${what} cut, ${left} more characters]`;
  // Sized for the most that could be left out, which is never fewer digits.
  const kept = Math.max(0, limit - note(text.length).length);
  return `${text.slice(0, kept)}${note(text.length - kept)}`;
}

/** The preview for one call, or null when it has nothing to show. */
export function toolDetailPreview(
  parts: ToolDetailParts,
  redactions: Redactions | null
): string | null {
  const given = inputText(parts.input);
  const input = given ? capped(redact(given, redactions), TOOL_DETAIL_INPUT, 'input') : '';
  const result = [
    outputText(parts, redactions),
    parts.exitCode !== null && parts.exitCode !== 0 ? `exit code ${parts.exitCode}` : null,
  ]
    .filter((line): line is string => line !== null && line.length > 0)
    .join('\n');
  if (!input && !result) return null;
  if (!result) return input;
  const room = TOOL_DETAIL_PREVIEW - (input ? input.length + 1 : 0);
  const output = capped(result, room, 'output');
  return input ? `${input}\n${output}` : output;
}
