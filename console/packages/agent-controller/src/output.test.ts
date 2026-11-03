import { describe, expect, it } from 'vitest';
import { mark, PLAIN, paint, rows, styleFor, table, tally } from './output';

const ESC = '\u001b[';
const COLOR = { color: true };

describe('styleFor', () => {
  it('colours a terminal', () => {
    expect(styleFor({ isTTY: true }, {})).toEqual({ color: true });
  });

  it('never colours a pipe or a log file', () => {
    expect(styleFor({ isTTY: false }, {})).toEqual({ color: false });
    expect(styleFor({}, {})).toEqual({ color: false });
  });

  it('respects NO_COLOR, and treats an empty one as unset', () => {
    expect(styleFor({ isTTY: true }, { NO_COLOR: '1' })).toEqual({ color: false });
    expect(styleFor({ isTTY: true }, { NO_COLOR: '' })).toEqual({ color: true });
  });

  it('does not colour a dumb terminal', () => {
    expect(styleFor({ isTTY: true }, { TERM: 'dumb' })).toEqual({ color: false });
  });
});

describe('paint and mark', () => {
  it('adds no escape codes without colour', () => {
    expect(paint(PLAIN, 'red', 'FAIL')).toBe('FAIL');
    expect(mark(PLAIN, 'fail')).toBe('FAIL');
    expect(mark(PLAIN, 'ok')).toBe('ok  ');
  });

  it('wraps the text in a colour and resets it', () => {
    expect(paint(COLOR, 'red', 'FAIL')).toBe(`${ESC}31mFAIL${ESC}39m`);
    expect(paint(COLOR, 'bold', '')).toBe('');
  });

  it('keeps marks four columns wide, coloured or not', () => {
    const visible = (text: string) => text.replace(/\u001b\[\d+m/g, '');
    for (const status of ['ok', 'warn', 'fail'] as const) {
      expect(visible(mark(COLOR, status))).toHaveLength(4);
      expect(mark(PLAIN, status)).toHaveLength(4);
    }
  });
});

describe('rows and table', () => {
  it('lines values up in one column', () => {
    expect(
      rows([
        ['ID', 'c-1'],
        ['Secret store', 'file'],
      ])
    ).toEqual(['  ID            c-1', '  Secret store  file']);
  });

  it('pads every column but the last', () => {
    expect(
      table(PLAIN, ['NAME', 'STATE'], [
        ['alice', 'running'],
        ['bob-the-builder', 'failed: a long detail that is not padded'],
      ])
    ).toEqual([
      '  NAME             STATE',
      '  alice            running',
      '  bob-the-builder  failed: a long detail that is not padded',
    ]);
  });
});

describe('tally', () => {
  it('says when everything passed', () => {
    expect(tally(['ok', 'ok'])).toBe('All 2 checks passed.');
  });

  it('counts problems and warnings', () => {
    expect(tally(['ok', 'fail', 'warn', 'warn'])).toBe('1 problem, 2 warnings.');
    expect(tally(['fail', 'fail'])).toBe('2 problems.');
    expect(tally(['warn'])).toBe('1 warning.');
  });
});
