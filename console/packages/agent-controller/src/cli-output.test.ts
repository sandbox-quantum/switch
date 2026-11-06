import { describe, expect, it } from 'vitest';
import {
  colorEnabled,
  createStyle,
  fields,
  indent,
  jsonDocument,
  mark,
  outcome,
  table,
} from './cli-output';

const ESC = String.fromCharCode(27);

describe('colorEnabled', () => {
  it('colours a terminal, and nothing that is piped or logged', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false);
  });

  it('honours NO_COLOR set to anything but the empty string, and a dumb terminal', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: 'anything' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
    expect(colorEnabled({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { TERM: 'xterm-256color' })).toBe(true);
  });
});

describe('createStyle', () => {
  it('returns text untouched without colour', () => {
    const style = createStyle(false);
    for (const paint of [style.bold, style.dim, style.red, style.green, style.yellow])
      expect(paint('text')).toBe('text');
  });

  it('wraps text in codes that end where they began, with colour', () => {
    const style = createStyle(true);
    expect(style.red('x')).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(style.bold('x')).toBe(`${ESC}[1mx${ESC}[22m`);
  });
});

describe('mark', () => {
  it('is four characters wide at every level, and the same words with or without colour', () => {
    for (const level of ['ok', 'warn', 'fail'] as const) {
      expect(mark(createStyle(false), level)).toHaveLength(4);
      expect(mark(createStyle(true), level).replaceAll(/\u001b\[\d+m/g, '')).toBe(
        mark(createStyle(false), level)
      );
    }
    expect(mark(createStyle(false), 'fail')).toBe('FAIL');
    expect(mark(createStyle(true), 'ok')).toContain(`${ESC}[32m`);
    expect(mark(createStyle(true), 'warn')).toContain(`${ESC}[33m`);
  });
});

describe('fields', () => {
  it('lines the values up under the longest label', () => {
    expect(
      fields([
        ['Server', 'https://switch.example.invalid'],
        ['Data directory', '/data'],
      ])
    ).toEqual(['Server:         https://switch.example.invalid', 'Data directory: /data']);
  });

  it('has nothing to write for no rows', () => {
    expect(fields([])).toEqual([]);
  });
});

describe('table', () => {
  const rows = [
    { name: 'code-reviewer', n: 5 },
    { name: 'ops', n: 12 },
  ];
  const columns = [
    { header: 'NAME', cell: (row: (typeof rows)[number]) => row.name },
    { header: 'N', cell: (row: (typeof rows)[number]) => String(row.n) },
  ];

  it('sizes each column to its widest cell and leaves no trailing spaces', () => {
    expect(table(createStyle(false), columns, rows)).toEqual([
      'NAME           N',
      'code-reviewer  5',
      'ops            12',
    ]);
  });

  it('pads before painting, so colour never changes the alignment', () => {
    const painted = table(
      createStyle(true),
      [{ ...columns[0]!, paint: (cell, _row, style) => style.green(cell) }, columns[1]!],
      rows
    );
    const stripped = painted.map((line) => line.replaceAll(/\u001b\[\d+m/g, ''));
    expect(stripped).toEqual(table(createStyle(false), columns, rows));
  });

  it('prints only the header for no rows', () => {
    expect(table(createStyle(false), columns, [])).toEqual(['NAME  N']);
  });
});

describe('outcome, indent and jsonDocument', () => {
  it('writes the headline, then each note indented under it, skipping empty ones', () => {
    expect(outcome(createStyle(false), 'Done.', ['one', '', 'two'])).toBe('Done.\n  one\n  two');
    expect(outcome(createStyle(false), 'Done.', [])).toBe('Done.');
  });

  it('does not indent blank lines', () => {
    expect(indent(['a', '', 'b'], 2)).toEqual(['  a', '', '  b']);
  });

  it('writes one document ending in a newline', () => {
    expect(jsonDocument({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });
});
