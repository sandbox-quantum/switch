/**
 * How the controller's commands lay out what they print: sections, aligned
 * rows and tables, and ok / warn / FAIL marks. Colour is used only when the
 * output is a terminal and `NO_COLOR` is not set, so piped or logged output is
 * plain text. No dependencies: the package ships as one bundle.
 */

export type Style = { color: boolean };

/** Plain text, for anything that is not a terminal. */
export const PLAIN: Style = { color: false };

/**
 * The style for a stream: colour only on a terminal, never with `NO_COLOR`
 * (any non-empty value, per no-color.org) or `TERM=dumb`.
 */
export function styleFor(
  stream: { isTTY?: boolean },
  env: Record<string, string | undefined>
): Style {
  const disabled = (env.NO_COLOR ?? '') !== '' || env.TERM === 'dumb';
  return { color: stream.isTTY === true && !disabled };
}

const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
} as const;

export type Paint = keyof typeof CODES;

export function paint(style: Style, color: Paint, text: string): string {
  if (!style.color || text === '') return text;
  const [open, close] = CODES[color];
  return `\u001b[${open}m${text}\u001b[${close}m`;
}

export type Status = 'ok' | 'warn' | 'fail';

const MARK: Record<Status, { text: string; color: Paint }> = {
  ok: { text: 'ok', color: 'green' },
  warn: { text: 'warn', color: 'yellow' },
  fail: { text: 'FAIL', color: 'red' },
};

/** A four-column mark, so the text after it lines up whatever the status. */
export function mark(style: Style, status: Status): string {
  const { text, color } = MARK[status];
  return paint(style, color, text) + ' '.repeat(4 - text.length);
}

export function heading(style: Style, text: string): string {
  return paint(style, 'bold', text);
}

/** `key  value` rows with the values in one column. Empty values are kept. */
export function rows(entries: [string, string][], indent = '  '): string[] {
  const width = Math.max(0, ...entries.map(([key]) => key.length));
  return entries.map(([key, value]) => `${indent}${key.padEnd(width)}  ${value}`.trimEnd());
}

/**
 * A table with a header row. Every column but the last is padded to its widest
 * cell, so a long last column (a detail) does not push the others around.
 */
export function table(
  style: Style,
  headers: string[],
  body: string[][],
  indent = '  '
): string[] {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...body.map((cells) => (cells[column] ?? '').length))
  );
  const line = (cells: string[]) =>
    `${indent}${cells
      .map((cell, column) => (column === cells.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join('  ')}`.trimEnd();
  return [heading(style, line(headers)), ...body.map(line)];
}

/** How many of each status, as a closing line: "2 problems, 1 warning." */
export function tally(statuses: Status[]): string {
  const fails = statuses.filter((status) => status === 'fail').length;
  const warns = statuses.filter((status) => status === 'warn').length;
  if (!fails && !warns) return `All ${statuses.length} checks passed.`;
  const parts: string[] = [];
  if (fails) parts.push(`${fails} problem${fails === 1 ? '' : 's'}`);
  if (warns) parts.push(`${warns} warning${warns === 1 ? '' : 's'}`);
  return `${parts.join(', ')}.`;
}
