import type { ToolDetailParts } from './tool-detail-buffer';

/**
 * What a chat may be shown of one tool call: its input and output, redacted
 * and cut to a preview. Switch keeps it only for a room that has asked to see
 * tool detail, and draws it where a reader opens a call on purpose.
 */

/** How much of a call a preview shows, in characters. */
export const TOOL_DETAIL_PREVIEW = 1500;

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
  if (input) sections.push(`Input: ${redact(input)}`);
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
  return [redact(head), '…', redact(tail)].filter((piece) => piece !== '').join('\n');
}

function cut(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  const dropped = characters.length - limit;
  return `${characters.slice(0, limit).join('')}\n… ${dropped} more characters not shown`;
}
