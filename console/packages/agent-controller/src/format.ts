/**
 * How the CLI's own commands print: aligned sections and ok / warn / fail
 * marks, in colour only on a terminal. Piped or logged output keeps the same
 * layout as plain text, with no escape codes, so it stays readable in a log
 * and easy to grep. The long-running `run` logs through `log.ts`, not this.
 */

export type Output = {
  /** Colour and symbols: only for a terminal that has not asked for neither. */
  rich: boolean;
};

export type Mark = 'ok' | 'warn' | 'fail';

/** Plain output: no escape codes, word marks. What tests and pipes get. */
export const PLAIN: Output = { rich: false };

/**
 * Rich output only on a terminal, and never where colour was turned off:
 * `NO_COLOR` set to anything but empty (https://no-color.org) or `TERM=dumb`.
 */
export function outputFor(stream: { isTTY?: boolean }, env: NodeJS.ProcessEnv): Output {
  return {
    rich: stream.isTTY === true && !env.NO_COLOR && env.TERM !== 'dumb',
  };
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  cyan: [36, 39],
} as const;

export type Tone = keyof typeof CODES;

export function paint(out: Output, tone: Tone, text: string): string {
  if (!out.rich) return text;
  const [open, close] = CODES[tone];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

const TONE: Record<Mark, Tone> = { ok: 'green', warn: 'yellow', fail: 'red' };
const SYMBOL: Record<Mark, string> = { ok: '✓', warn: '!', fail: '✗' };
/** Padded to one width, as the controller has always printed them. */
const WORD: Record<Mark, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** A mark for one result: a coloured symbol on a terminal, a word otherwise. */
export function mark(out: Output, status: Mark): string {
  return out.rich ? paint(out, TONE[status], SYMBOL[status]) : WORD[status];
}

export function heading(out: Output, title: string): string {
  return paint(out, 'bold', paint(out, 'cyan', title));
}

/**
 * `Label:  value` rows with the labels padded to one width, indented under a
 * heading. The colon stays: scripts find a row by its label and colon.
 */
export function rows(out: Output, entries: ReadonlyArray<readonly [string, string]>): string[] {
  const width = Math.max(0, ...entries.map(([label]) => label.length + 1));
  return entries.map(
    ([label, value]) => `  ${paint(out, 'dim', `${label}:`.padEnd(width))}  ${value}`
  );
}

/** How many of each mark, as a closing line: "5 ok, 1 warning, 0 failed". */
export function summary(out: Output, marks: readonly Mark[]): string {
  const count = (status: Mark) => marks.filter((each) => each === status).length;
  const warnings = count('warn');
  return [
    paint(out, 'green', `${count('ok')} ok`),
    paint(out, 'yellow', `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`),
    paint(out, 'red', `${count('fail')} failed`),
  ].join(', ');
}

/**
 * A command's result line. On a terminal it leads with its mark; plain, it is
 * the sentence alone, exactly as the controller printed it before marks.
 */
export function result(out: Output, status: Mark, text: string): string {
  return out.rich ? `${mark(out, status)} ${text}` : text;
}

/** A follow-up line under a result: what to run next, or where things are. */
export function note(out: Output, text: string): string {
  return out.rich ? `  ${paint(out, 'dim', text)}` : text;
}
