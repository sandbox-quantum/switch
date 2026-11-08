/** What the command-line output is written to: only whether it is a terminal matters. */
export type OutputStream = { isTTY?: boolean };

export type Style = {
  readonly color: boolean;
  bold(text: string): string;
  dim(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
};

export type Level = 'ok' | 'warn' | 'fail';

const ESC = String.fromCharCode(27);

function wrap(open: number, close: number): (text: string) => string {
  return (text) => `${ESC}[${open}m${text}${ESC}[${close}m`;
}

const plain = (text: string): string => text;

/**
 * Colour only goes to a terminal that has not asked for none: `NO_COLOR` set to
 * anything but the empty string turns it off (no-color.org), as does `TERM=dumb`.
 */
export function colorEnabled(stream: OutputStream, env: NodeJS.ProcessEnv): boolean {
  if (!stream.isTTY) return false;
  if ((env.NO_COLOR ?? '') !== '') return false;
  return env.TERM !== 'dumb';
}

export function createStyle(color: boolean): Style {
  if (!color) return { color, bold: plain, dim: plain, red: plain, green: plain, yellow: plain };
  return {
    color,
    bold: wrap(1, 22),
    dim: wrap(2, 22),
    red: wrap(31, 39),
    green: wrap(32, 39),
    yellow: wrap(33, 39),
  };
}

/** The style for what a command writes to standard output. */
export function stdoutStyle(): Style {
  return createStyle(colorEnabled(process.stdout, process.env));
}

const MARKS: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

/** A level as the word a script can grep for, in colour on a terminal; always four characters wide. */
export function mark(style: Style, level: Level): string {
  const text = MARKS[level];
  return level === 'ok'
    ? style.green(text)
    : level === 'warn'
      ? style.yellow(text)
      : style.red(text);
}

export function heading(style: Style, text: string): string {
  return style.bold(text);
}

/** `Label:  value` lines, the values lined up. */
export function fields(rows: readonly (readonly [label: string, value: string])[]): string[] {
  const width = Math.max(0, ...rows.map(([label]) => label.length)) + 1;
  return rows.map(([label, value]) => `${`${label}:`.padEnd(width)} ${value}`);
}

export type Column<T> = {
  header: string;
  cell: (row: T) => string;
  /** Colours the cell once it is padded; the width is measured on the plain text. */
  paint?: (cell: string, row: T, style: Style) => string;
};

/** Rows under a header, each column as wide as its widest cell; no line ends in spaces. */
export function table<T>(
  style: Style,
  columns: readonly Column<T>[],
  rows: readonly T[]
): string[] {
  const cells = rows.map((row) => columns.map((column) => column.cell(row)));
  const widths = columns.map((column, index) =>
    Math.max(column.header.length, ...cells.map((line) => line[index]?.length ?? 0))
  );
  const last = columns.length - 1;
  const pad = (text: string, index: number) =>
    index === last ? text : text.padEnd(widths[index] ?? 0);
  const header = columns.map((column, index) => style.dim(pad(column.header, index)));
  const lines = [header.join('  ').trimEnd()];
  rows.forEach((row, rowIndex) => {
    const line = columns.map((column, index) => {
      const padded = pad(cells[rowIndex]?.[index] ?? '', index);
      return column.paint ? column.paint(padded, row, style) : padded;
    });
    lines.push(line.join('  ').trimEnd());
  });
  return lines;
}

/** A command's result: what happened, then what to know about it, a line each underneath. */
export function outcome(style: Style, headline: string, notes: readonly string[]): string {
  return [style.bold(headline), ...indent(notes.filter(Boolean), 2)].join('\n');
}

export function indent(lines: readonly string[], spaces: number): string[] {
  const pad = ' '.repeat(spaces);
  return lines.map((line) => (line === '' ? line : `${pad}${line}`));
}

/** What a `--json` flag writes: one document, never mixed with colour or prose. */
export function jsonDocument(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
