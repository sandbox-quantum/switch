import type { Redactions } from '../host/redaction';
import { TOOL_OUTPUT_GAP, type HostToolDetail } from '../host/tool-detail-buffer';

/**
 * What a tool call shows in a room: its input and its output as one bounded,
 * redacted text, small enough to stay in one 4096-character item part.
 */
const INPUT_LIMIT = 1000;
const OUTPUT_HEAD = 2000;
const OUTPUT_TAIL = 800;
export const TOOL_TEXT_CUT = '[…truncated]';

function clipHead(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false };
  // A cut inside a word may be inside a secret too short to be recognised.
  return { text: text.slice(0, limit).replace(/\S+$/, ''), clipped: true };
}

function clipTail(text: string, limit: number): { text: string; clipped: boolean } {
  if (text.length <= limit) return { text, clipped: false };
  return {
    text: text.slice(text.length - limit).replace(/^\S+/, ''),
    clipped: true,
  };
}

function inputText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  if (typeof input === 'object' && 'command' in input) {
    const { command } = input as { command: unknown };
    if (typeof command === 'string') return `$ ${command}`;
    if (Array.isArray(command) && command.every((part) => typeof part === 'string'))
      return `$ ${command.join(' ')}`;
  }
  return JSON.stringify(input) ?? '';
}

/**
 * The text for one tool call, '' when it has neither input nor output.
 *
 * Redaction runs on the whole text held and the cut comes after it, never
 * before, so a secret is not cut in half and left unrecognised. A cut that
 * lands inside a word drops the word. While the call is `streaming`, the last
 * word of its output is held back as well: it may be the start of a secret
 * whose end has not arrived.
 */
export function toolDetailText(
  detail: HostToolDetail,
  redactions: Redactions,
  streaming: boolean
): string {
  const input = clipHead(redactions.detail(inputText(detail.input)), INPUT_LIMIT);
  const sections: string[] = [];
  if (input.text) sections.push(`Input: ${input.text}${input.clipped ? ` ${TOOL_TEXT_CUT}` : ''}`);
  if (detail.output) {
    let output = detail.output;
    if (streaming) output = output.replace(/\S+$/, '').trimEnd();
    const gap = detail.truncated ? output.lastIndexOf(TOOL_OUTPUT_GAP) : -1;
    const head = gap >= 0 ? output.slice(0, gap).replace(/\S+$/, '') : output;
    const tail = gap >= 0 ? output.slice(gap + TOOL_OUTPUT_GAP.length).replace(/^\S+/, '') : '';
    const redacted = redactions.detail(gap >= 0 ? `${head}${TOOL_OUTPUT_GAP}${tail}` : head);
    const at = gap >= 0 ? redacted.lastIndexOf(TOOL_OUTPUT_GAP) : -1;
    const shownHead = clipHead(at >= 0 ? redacted.slice(0, at) : redacted, OUTPUT_HEAD);
    const shownTail = clipTail(
      at >= 0 ? redacted.slice(at + TOOL_OUTPUT_GAP.length) : '',
      OUTPUT_TAIL
    );
    const clipped = at >= 0 || shownHead.clipped || shownTail.clipped;
    const body = clipped
      ? [shownHead.text, TOOL_TEXT_CUT, shownTail.text].filter(Boolean).join('\n')
      : shownHead.text;
    const exit =
      detail.exitCode !== null && detail.exitCode !== 0 ? ` (exit ${detail.exitCode})` : '';
    if (body.trim()) sections.push(`Output${exit}:\n${body.trimEnd()}`);
  }
  return sections.join('\n');
}
