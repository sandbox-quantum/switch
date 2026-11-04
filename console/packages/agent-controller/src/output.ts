/**
 * How this CLI prints. One module owns the colour decision, the marks a check
 * carries and the column layout, so every command reads the same way and a
 * coloured cell can never move where a column starts.
 */

/** SGR sequences: what a width measurement must skip, and what a plain stream must never carry. */
const SGR = /\u001B\[[0-9;]*m/g;

const CODE: Record<Style, number> = {
  bold: 1,
  dim: 2,
  red: 31,
  green: 32,
  yellow: 33,
  cyan: 36,
};

export type Style = 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'cyan';

/** The three states a check reports, and the only marks this CLI prints. */
export type Mark = 'ok' | 'warn' | 'fail';

/**
 * Deliberately ASCII and all of one width: the marks read the same in a
 * terminal, in a log file, and in a Windows console with no UTF-8 code page.
 */
export const MARKS: Record<Mark, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' };

const MARK_STYLE: Record<Mark, Style> = { ok: 'green', warn: 'yellow', fail: 'red' };

/** The cell a mark is printed as, wherever a line is marked. */
export function markCell(mark: Mark): Cell {
  return { text: MARKS[mark], style: MARK_STYLE[mark] };
}

/** A table cell whose colour is applied after its column width is measured. */
export type Cell = { text: string; style: Style | null };

/** One row of a table: plain strings, or cells that carry a colour. */
export type Row = readonly (string | Cell)[];

/** A labelled value, as the identity and machine sections are made of. */
export type Field = { label: string; value: string | Cell };

/** One line of a check list: what was checked, what was found, and how to fix it. */
export type CheckLine = { name: string; status: Mark; detail: string; fix: string | null };

/** What the colour decision needs of a stream; `process.stdout` and a test double both fit. */
export type ColorTarget = { isTTY?: boolean };

/**
 * Whether what goes to `stream` is coloured. Colour is for a person at a
 * terminal, so it is off for a redirected stream, off whenever `NO_COLOR`
 * holds any non-empty value (no-color.org), and off for `TERM=dumb`. stdout
 * and stderr are decided one at a time, because either can be redirected
 * while the other stays a terminal.
 */
export function colorFor(stream: ColorTarget, env: NodeJS.ProcessEnv): boolean {
  if (stream.isTTY !== true) return false;
  if ((env.NO_COLOR ?? '') !== '') return false;
  return env.TERM !== 'dumb';
}

/**
 * The width a reader sees: colour codes are left out of the count, and a
 * character outside the basic plane counts once rather than as its two
 * UTF-16 units.
 */
export function visibleWidth(text: string): number {
  return Array.from(text.replace(SGR, '')).length;
}

function pad(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + ' '.repeat(missing) : text;
}

function cellText(cell: string | Cell): string {
  return typeof cell === 'string' ? cell : cell.text;
}

/** Writes one command's output to one stream, in that stream's colour. */
export class Printer {
  private constructor(
    private readonly out: (text: string) => void,
    /** Whether this stream takes colour; read it rather than deciding again. */
    readonly color: boolean
  ) {}

  /** A printer for a real stream, colouring by what that stream and the environment allow. */
  static on(stream: NodeJS.WriteStream, env: NodeJS.ProcessEnv): Printer {
    return new Printer(
      (text) => {
        stream.write(text);
      },
      colorFor(stream, env)
    );
  }

  /** A printer that collects what it is given, for tests and for either colour by hand. */
  static to(write: (text: string) => void, color: boolean): Printer {
    return new Printer(write, color);
  }

  /** `text` in `style`, or `text` untouched when this stream takes no colour. */
  paint(text: string, style: Style): string {
    return this.color ? `\u001B[${CODE[style]}m${text}\u001B[0m` : text;
  }

  line(text: string): void {
    this.out(`${text}\n`);
  }

  blank(): void {
    this.out('\n');
  }

  /** A section title, with the blank line that separates it from what came before. */
  heading(text: string): void {
    this.blank();
    this.line(this.paint(text, 'bold'));
  }

  /** The title line a command opens with: no blank line above it. */
  title(text: string): void {
    this.line(this.paint(text, 'bold'));
  }

  /**
   * Rows laid out in columns two spaces apart, indented by two. Each column is
   * as wide as its widest cell measured by `visibleWidth`, so a coloured cell
   * takes the same room as a plain one; the last column is never padded.
   */
  table(rows: readonly Row[]): void {
    const widths: number[] = [];
    for (const row of rows)
      row.forEach((cell, index) => {
        widths[index] = Math.max(widths[index] ?? 0, visibleWidth(cellText(cell)));
      });
    for (const row of rows) {
      const cells = row.map((cell, index) => {
        const text =
          typeof cell === 'string'
            ? cell
            : cell.style === null
              ? cell.text
              : this.paint(cell.text, cell.style);
        return index === row.length - 1 ? text : pad(text, widths[index] ?? 0);
      });
      this.line(`  ${cells.join('  ')}`.trimEnd());
    }
  }

  /** One indented line under a heading, where there is nothing to lay out in columns. */
  note(text: string): void {
    this.line(`  ${text}`);
  }

  /** Labelled values, the labels aligned into one column. */
  fields(fields: readonly Field[]): void {
    this.table(fields.map((field) => [field.label, field.value]));
  }

  /**
   * A check list: the mark, what was checked, and what was found with its fix
   * on the same line, so a problem is never a bare failure mark.
   */
  checks(lines: readonly CheckLine[]): void {
    this.table(
      lines.map((line) => [
        markCell(line.status),
        line.name,
        line.fix ? `${line.detail} ${this.paint('Fix:', 'cyan')} ${line.fix}` : line.detail,
      ])
    );
  }

  /**
   * The whole document a `--json` run writes, and the only thing on that
   * stream: never coloured, so the output parses wherever it is sent.
   */
  json(document: unknown): void {
    this.out(`${JSON.stringify(document, null, 2)}\n`);
  }
}
