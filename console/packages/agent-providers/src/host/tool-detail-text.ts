import { redactSecrets } from '@switch-console/shared/secret-redaction';
import type { Redactions } from './redaction';
import type { HostToolDetail } from './tool-detail-buffer';

/** The most a room is shown of one tool call, input, output and exit code together. */
export const TOOL_DETAIL_LIMIT = 2000;
/** The most of that the call's input may take. */
export const TOOL_INPUT_PREVIEW = 500;

/** What the buffer puts where it left out the middle of an output. */
const OUTPUT_CUT = '\n…\n';
/** What the buffer puts at the end of a value it clipped. */
const CLIP_MARK = '…';
const LEFT_OUT = '… part of this was not kept …';
/** Room kept for the note that says how much a preview left out. */
const NOTE_ROOM = 48;
/**
 * A private key whose block a cut left open: begun and not ended before the
 * end of what was kept, or ended after its start was left out. The whole
 * block is masked where both ends are kept; these mask it up to the cut.
 */
const OPEN_KEY =
  /-----BEGIN [^\n]*PRIVATE KEY-----(?![\s\S]*-----END [^\n]*PRIVATE KEY-----)[\s\S]*$/;
const CLOSING_KEY = /^(?:(?!-----BEGIN )[\s\S])*?-----END [^\n]*PRIVATE KEY-----/;
const KEY_LEFT_OUT = '[REDACTED_PEM_BLOCK]';

/**
 * A tool call's input and output as a room is shown them, when the room has
 * asked to see them.
 *
 * The buffer may already have cut a part, and a cut can run through a secret,
 * leaving a piece no pattern recognises. So each part the buffer kept whole is
 * redacted on its own, every secret this host knows of and everything shaped
 * like one, and the partial line at each cut is dropped. Only then is a part
 * cut to its preview, again at the end of a line, with a note saying how much
 * was left out.
 */
export function toolDetailText(detail: HostToolDetail, redactions: Redactions | null): string {
  const scrub = (text: string) =>
    redactSecrets(redactions ? redactions.text(text) : text)
      .replace(OPEN_KEY, KEY_LEFT_OUT)
      .replace(CLOSING_KEY, KEY_LEFT_OUT);
  const parts: string[] = [];
  const input = inputText(detail.input);
  if (input)
    parts.push(`Input:\n${preview(keptInput(input, detail.truncated, scrub), TOOL_INPUT_PREVIEW)}`);
  const exit = detail.exitCode === null ? null : `Exit code: ${detail.exitCode}`;
  if (detail.output) {
    const used = parts.join('\n\n').length + (exit ? exit.length + 2 : 0);
    const room = TOOL_DETAIL_LIMIT - used - 'Output:\n'.length - 4 - NOTE_ROOM;
    const kept = keptOutput(detail.output, detail.outputCut ?? null, scrub);
    parts.push(`Output:\n${preview(kept, room)}`);
  }
  if (exit) parts.push(exit);
  return parts.join('\n\n');
}

function inputText(input: unknown): string {
  if (input === null || input === undefined) return '';
  if (typeof input === 'string') return input;
  return JSON.stringify(input, null, 2) ?? '';
}

/**
 * The input with each line the buffer cut replaced by a note. The buffer
 * marks a value it clipped with `…` at its end, which in the input as shown
 * ends its line, before any closing quote and comma. An input that was not
 * clipped is kept whole, `…` and all.
 */
function keptInput(input: string, truncated: boolean, scrub: (text: string) => string): string {
  if (!truncated) return scrub(input);
  return scrub(
    input
      .split('\n')
      .map((line) => (line.replace(/",?$/, '').endsWith(CLIP_MARK) ? LEFT_OUT : line))
      .join('\n')
  );
}

/**
 * The output the buffer kept, each end redacted on its own: the head without
 * its last line and the tail without its first, since the cut ran through both.
 * `cut` is where the buffer says it cut, never where the text looks cut: an
 * output can print `…` on a line of its own.
 */
function keptOutput(output: string, cut: number | null, scrub: (text: string) => string): string {
  if (cut === null) return scrub(output);
  if (output.slice(cut, cut + OUTPUT_CUT.length) !== OUTPUT_CUT)
    throw new Error('The output is not cut where its buffer says it is.');
  const head = output.slice(0, cut);
  const tail = output.slice(cut + OUTPUT_CUT.length);
  const wholeHead = head.includes('\n') ? head.slice(0, head.lastIndexOf('\n')) : '';
  const wholeTail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : '';
  return [scrub(wholeHead), LEFT_OUT, scrub(wholeTail)].filter(Boolean).join('\n');
}

/** `text` up to `limit`, ended at the end of a line, with a note of what it left out. */
function preview(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = text.lastIndexOf('\n', limit);
  const kept = end === -1 ? '' : text.slice(0, end);
  return `${kept}\n… ${text.length - kept.length} more characters not shown.`;
}
