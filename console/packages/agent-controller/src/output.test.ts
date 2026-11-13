import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import { fields, heading, notice, outputStyle, plain } from './output';

describe('output style', () => {
  it('uses colour only when the destination is a terminal', () => {
    expect(outputStyle({ isTTY: true }, {})).toEqual({ color: true });
    expect(outputStyle({ isTTY: false }, { FORCE_COLOR: '1' })).toEqual({ color: false });
    expect(outputStyle({}, {})).toEqual({ color: false });
  });

  it('honours NO_COLOR, including an empty value, and dumb terminals', () => {
    expect(outputStyle({ isTTY: true }, { NO_COLOR: '' })).toEqual({ color: false });
    expect(outputStyle({ isTTY: true }, { NO_COLOR: '1', FORCE_COLOR: '1' })).toEqual({
      color: false,
    });
    expect(outputStyle({ isTTY: true }, { TERM: 'dumb' })).toEqual({ color: false });
  });
});

describe('human output', () => {
  it('aligns values and indents continuation lines', () => {
    expect(
      fields([
        ['Name', 'build-box'],
        ['Data directory', '/data/controller'],
        ['Problem', 'Cannot connect\nCheck the server address.'],
      ])
    ).toBe(
      '  Name:           build-box\n' +
        '  Data directory: /data/controller\n' +
        '  Problem:        Cannot connect\n' +
        '                  Check the server address.'
    );
  });

  it('keeps empty values and handles an empty section', () => {
    expect(fields([])).toBe('');
    expect(fields([['Name', '']])).toBe('  Name: ');
    expect(heading('', { color: false })).toBe('');
  });

  it('does not truncate long paths, names or Unicode', () => {
    const value = `/data/${'long-directory/'.repeat(30)}演出`;
    expect(fields([['Path', value]])).toBe(`  Path: ${value}`);
    expect(notice('info', value, { color: false })).toBe(`[INFO] ${value}`);
  });

  it.each([
    ['ok', '[OK]'],
    ['warn', '[WARN]'],
    ['fail', '[ERROR]'],
    ['info', '[INFO]'],
  ] as const)('makes %s readable without colour', (status, mark) => {
    const uncolored = notice(status, 'The result\nNext step', { color: false });
    expect(uncolored).toBe(`${mark} The result\n${' '.repeat(mark.length + 1)}Next step`);
    expect(stripVTControlCharacters(notice(status, 'The result\nNext step', { color: true }))).toBe(
      uncolored
    );
  });

  it('colours headings only when requested and keeps them on one line', () => {
    expect(heading('Controller\nstatus', { color: false })).toBe('Controller status');
    expect(heading('Controller', { color: true })).toBe('\x1b[1;36mController\x1b[0m');
  });

  it('removes ANSI colours, cursor commands, hyperlinks and control characters', () => {
    const input =
      '\x1b[31mred\x1b[0m\x1b[2J\x1b]8;;https://example.invalid\x07link\x1b]8;;\x07' +
      '\x00\x07\x08\x1b\x7f\x85\r\nnext\ttab\rcarriage\n\n';
    expect(plain(input)).toBe('redlink\nnext  tabcarriage');
    expect(fields([['\x1b[31mName\x1b[0m', input]])).toBe(
      '  Name: redlink\n        next  tabcarriage'
    );
    expect(notice('warn', input, { color: false })).toBe(
      '[WARN] redlink\n       next  tabcarriage'
    );
    expect(heading(input, { color: false })).toBe('redlink next  tabcarriage');
  });

  it('adds only its own ANSI sequences to untrusted text', () => {
    expect(notice('ok', '\x1b[2Jready\x1b[31m', { color: true })).toBe('\x1b[32m[OK]\x1b[0m ready');
    expect(heading('\x1b[2JStatus\x1b[31m', { color: true })).toBe('\x1b[1;36mStatus\x1b[0m');
  });
});
