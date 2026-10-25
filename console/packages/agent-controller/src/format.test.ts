import { describe, expect, it } from 'vitest';
import { mark, note, outputFor, PLAIN, paint, result, rows, summary } from './format';

const RICH = { rich: true };
const ESCAPE = /\u001b\[/;

describe('outputFor', () => {
  it('is rich only on a terminal', () => {
    expect(outputFor({ isTTY: true }, {})).toEqual({ rich: true });
    expect(outputFor({ isTTY: false }, {})).toEqual({ rich: false });
    expect(outputFor({}, {})).toEqual({ rich: false });
  });

  it('honours a non-empty NO_COLOR, whatever its value, and TERM=dumb', () => {
    expect(outputFor({ isTTY: true }, { NO_COLOR: '1' })).toEqual({ rich: false });
    expect(outputFor({ isTTY: true }, { NO_COLOR: 'false' })).toEqual({ rich: false });
    expect(outputFor({ isTTY: true }, { TERM: 'dumb' })).toEqual({ rich: false });
    expect(outputFor({ isTTY: true }, { NO_COLOR: '', TERM: 'xterm-256color' })).toEqual({
      rich: true,
    });
  });
});

describe('plain output', () => {
  it('has no escape codes', () => {
    expect(paint(PLAIN, 'red', 'x')).toBe('x');
    expect(
      [mark(PLAIN, 'ok'), summary(PLAIN, ['ok', 'warn', 'fail']), note(PLAIN, 'n')].join('')
    ).not.toMatch(ESCAPE);
  });

  it('marks with words of one width, as the controller always has', () => {
    expect(['ok', 'warn', 'fail'].map((status) => mark(PLAIN, status as 'ok'))).toEqual([
      'ok  ',
      'warn',
      'FAIL',
    ]);
  });

  it('prints result lines and notes as the sentence alone', () => {
    expect(result(PLAIN, 'ok', 'Installed 0.2.0.')).toBe('Installed 0.2.0.');
    expect(note(PLAIN, 'Data: /data')).toBe('Data: /data');
  });
});

describe('rich output', () => {
  it('marks with coloured symbols', () => {
    expect(mark(RICH, 'ok')).toBe('\u001b[32m✓\u001b[39m');
    expect(mark(RICH, 'warn')).toBe('\u001b[33m!\u001b[39m');
    expect(mark(RICH, 'fail')).toBe('\u001b[31m✗\u001b[39m');
  });

  it('leads a result line with its mark', () => {
    expect(result(RICH, 'ok', 'Done.')).toBe('\u001b[32m✓\u001b[39m Done.');
  });
});

describe('rows', () => {
  it('pads the labels to one width', () => {
    expect(
      rows(PLAIN, [
        ['Server', 'https://switch.example.com'],
        ['Secret store', 'files'],
      ])
    ).toEqual(['  Server:        https://switch.example.com', '  Secret store:  files']);
  });
});

describe('summary', () => {
  it('counts each mark, with one warning or several', () => {
    expect(summary(PLAIN, ['ok', 'ok', 'warn', 'fail'])).toBe('2 ok, 1 warning, 1 failed');
    expect(summary(PLAIN, ['warn', 'warn'])).toBe('0 ok, 2 warnings, 0 failed');
  });
});
