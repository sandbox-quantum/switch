import type { ToolDetailParts } from './tool-detail-buffer';

/**
 * What a chat may be shown of one tool call: its input and output, redacted
 * and cut to a preview. Switch keeps it only for a room that has asked to see
 * tool detail, and draws it where a reader opens a call on purpose.
 */

/**
 * How much of a call a preview shows, in characters, notes included: what
 * Switch accepts for a call's detail (`MAX_TOOL_DETAIL_CHARS`).
 */
export const TOOL_DETAIL_PREVIEW = 2000;

/** How much of that the call's input may take, so its output still shows. */
export const TOOL_DETAIL_INPUT = 500;

/** Where the middle of a long output was dropped before it reached the host. */
export const OUTPUT_MIDDLE_DROPPED = '… middle of the output not kept';

/**
 * The preview of `parts`, or null when the call has neither input nor output.
 *
 * `redact` runs on whole pieces only. An output whose middle the buffer
 * dropped is two pieces, each with a cut, so each loses the partial line at
 * its cut before it is redacted on its own: a secret the cut split leaves
 * nothing behind, where redacting the joined text would leave its two halves,
 * neither of which a pattern matches. The preview is cut to its size last,
 * once nothing in it is unredacted.
 */
export function toolDetailPreview(
  parts: ToolDetailParts,
  redact: (text: string) => string
): string | null {
  const sections: string[] = [];
  const input = inputText(parts.input);
  if (input) sections.push(`Input: ${cut(redact(input), TOOL_DETAIL_INPUT)}`);
  if (parts.hasOutput) sections.push(`Output:\n${outputText(parts, redact)}`);
  if (!sections.length) return null;
  return cut(sections.join('\n'), TOOL_DETAIL_PREVIEW);
}

function inputText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  return JSON.stringify(input) ?? '';
}

function outputText(parts: ToolDetailParts, redact: (text: string) => string): string {
  if (!parts.outputClipped) return redact(parts.head + parts.tail);
  const head = parts.head.slice(0, Math.max(parts.head.lastIndexOf('\n'), 0));
  const newline = parts.tail.indexOf('\n');
  const tail = newline === -1 ? '' : parts.tail.slice(newline + 1);
  return [redact(head), OUTPUT_MIDDLE_DROPPED, redact(tail)]
    .filter((piece) => piece !== '')
    .join('\n');
}

/**
 * `text` in at most `limit` characters, saying how much was left out. The note
 * counts toward the limit, so what is cut never grows past it.
 */
function cut(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const note = (dropped: number) => `\n… ${dropped} more characters not shown`;
  // The note's length depends on the count it states, which grows as less is
  // kept, so this steps back until both fit.
  let kept = limit;
  while (kept > 0 && kept + note(characters.length - kept).length > limit) kept--;
  return `${characters.slice(0, kept).join('')}${note(characters.length - kept)}`;
}
