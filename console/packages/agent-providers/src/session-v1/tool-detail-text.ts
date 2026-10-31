import type { Redactions } from '../host/redaction';
import type { ToolDetailParts } from '../host/tool-detail-buffer';

/**
 * What a tool call shows in a room: its input and its output as one bounded,
 * redacted text, small enough to stay in one 4096-character item part.
 */
const INPUT_LIMIT = 1000;
const OUTPUT_HEAD = 2000;
const OUTPUT_TAIL = 800;
export const TOOL_TEXT_CUT = '[…truncated]';

/** The start of `text` within `limit`; a cut inside a word drops the word, which may be part of a secret too short to be recognised. */
function clipHead(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false };
  return { text: text.slice(0, limit).replace(/\S+$/, ''), clipped: true };
}

function clipTail(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false };
  return { text: text.slice(text.length - limit).replace(/^\S+/, ''), clipped: true };
}

/** A shell call's command as a shell line; any other call's arguments as JSON, whatever they are named. */
function inputText(input: unknown, type: string): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (type === 'command_execution' && typeof input === 'object' && 'command' in input) {
    const { command } = input as { command: unknown };
    if (typeof command === 'string') return `$ ${command}`;
    if (Array.isArray(command) && command.every((part) => typeof part === 'string'))
      return `$ ${command.join(' ')}`;
  }
  return JSON.stringify(input) ?? '';
}

/** `text` and the cut note, apart by a space, for whichever of them there is. */
function withCut(text: string, clipped: boolean): string {
  return [text, clipped ? TOOL_TEXT_CUT : ''].filter(Boolean).join(' ');
}

/**
 * The text for one tool call, '' when it has neither input nor output.
 *
 * Redaction runs on everything held and the cut comes after it, never before,
 * so a secret is not cut in half and left unrecognised. A cut that lands
 * inside a word drops the word. While the call is `streaming`, the last word
 * of its output is held back as well: it may be the start of a secret whose
 * end has not arrived.
 */
export function toolDetailText(
  parts: ToolDetailParts,
  redactions: Redactions,
  streaming: boolean
): string {
  const input = clipHead(redactions.detail(inputText(parts.input, parts.type)), INPUT_LIMIT);
  const sections: string[] = [];
  if (input.text || input.clipped) sections.push(`Input: ${withCut(input.text, input.clipped)}`);

  let { head, tail } = parts;
  if (!parts.outputClipped) [head, tail] = [head + tail, ''];
  else {
    // The buffer cut both ends of what lies between them mid-word.
    head = head.replace(/\S+$/, '');
    tail = tail.replace(/^\S+/, '');
  }
  if (streaming) {
    if (tail) tail = tail.replace(/\S+$/, '').trimEnd();
    else head = head.replace(/\S+$/, '').trimEnd();
  }
  const shownHead = clipHead(redactions.detail(head), OUTPUT_HEAD);
  const shownTail = clipTail(redactions.detail(tail), OUTPUT_TAIL);
  const clipped = parts.outputClipped || shownHead.clipped || shownTail.clipped;
  const body = clipped
    ? [shownHead.text, TOOL_TEXT_CUT, shownTail.text].filter(Boolean).join('\n')
    : shownHead.text;
  const exit = parts.exitCode !== null && parts.exitCode !== 0 ? ` (exit ${parts.exitCode})` : '';
  if (body.trim()) sections.push(`Output${exit}:\n${body.trimEnd()}`);
  return sections.join('\n');
}
