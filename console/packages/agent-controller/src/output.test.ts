import { describe, expect, it } from 'vitest';
import { colorFor, MARKS, markCell, Printer, visibleWidth } from './output';

/** A printer that keeps what it was given, so a test can read the lines back. */
function collector(color: boolean): { printer: Printer; lines: () => string[] } {
  const written: string[] = [];
  return {
    printer: Printer.to((text) => written.push(text), color),
    lines: () => written.join('').split('\n'),
  };
}

const ESCAPE = /\u001B\[/;

describe('colorFor', () => {
  it('colours a terminal and nothing else', () => {
    expect(colorFor({ isTTY: true }, {})).toBe(true);
    expect(colorFor({ isTTY: false }, {})).toBe(false);
    expect(colorFor({}, {})).toBe(false);
  });

  it('obeys NO_COLOR for any non-empty value, and ignores an empty one', () => {
    expect(colorFor({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorFor({ isTTY: true }, { NO_COLOR: '0' })).toBe(false);
    expect(colorFor({ isTTY: true }, { NO_COLOR: 'anything' })).toBe(false);
    expect(colorFor({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
  });

  it('leaves a dumb terminal plain', () => {
    expect(colorFor({ isTTY: true }, { TERM: 'dumb' })).toBe(false);
    expect(colorFor({ isTTY: true }, { TERM: 'xterm-256color' })).toBe(true);
  });

  it('decides each stream on its own, so one may be redirected alone', () => {
    const env = { TERM: 'xterm-256color' };
    const stdout = { isTTY: true };
    const stderr = { isTTY: false };
    expect([colorFor(stdout, env), colorFor(stderr, env)]).toEqual([true, false]);
  });
});

describe('visibleWidth', () => {
  it('counts what a reader sees, not the colour codes', () => {
    expect(visibleWidth('claude')).toBe(6);
    expect(visibleWidth('\u001B[32mclaude\u001B[0m')).toBe(6);
    expect(visibleWidth('\u001B[1m\u001B[31mok\u001B[0m')).toBe(2);
    expect(visibleWidth('')).toBe(0);
  });
});

describe('marks', () => {
  it('are one ASCII set of one width, coloured by what they report', () => {
    expect(Object.values(MARKS).map((mark) => mark.length)).toEqual([4, 4, 4]);
    expect(MARKS).toEqual({ ok: 'ok  ', warn: 'warn', fail: 'FAIL' });
    for (const mark of Object.values(MARKS)) expect(mark).toMatch(/^[\x20-\x7E]+$/);
    expect(markCell('ok')).toEqual({ text: 'ok  ', style: 'green' });
    expect(markCell('warn')).toEqual({ text: 'warn', style: 'yellow' });
    expect(markCell('fail')).toEqual({ text: 'FAIL', style: 'red' });
  });
});

describe('table alignment', () => {
  it('lines columns up on the visible text, not the coloured string', () => {
    const plain = collector(false);
    const painted = collector(true);
    const rows = [
      [{ text: 'ok  ', style: 'green' as const }, 'Node', 'v24.14.0'],
      [{ text: 'FAIL', style: 'red' as const }, 'Providers', 'none signed in'],
      ['    ', 'a-much-longer-name', 'x'],
    ];
    plain.printer.table(rows);
    painted.printer.table(rows);
    const columnStart = (line: string) => line.indexOf('Node') + line.indexOf('Providers');
    const strip = (line: string) => line.replace(/\u001B\[[0-9;]*m/g, '');
    expect(plain.lines().map(strip)).toEqual(painted.lines().map(strip));
    const [first = '', second = ''] = plain.lines();
    expect(first.indexOf('v24.14.0')).toBe(second.indexOf('none signed in'));
    expect(columnStart(first)).toBeGreaterThan(0);
  });

  it('pads every column but the last, and never leaves trailing blanks', () => {
    const { printer, lines } = collector(false);
    printer.table([
      ['a', 'bb', 'c'],
      ['aaa', 'b', ''],
    ]);
    expect(lines()).toEqual(['  a    bb  c', '  aaa  b', '']);
  });

  it('keeps a coloured cell the same width as a plain one', () => {
    const { printer, lines } = collector(true);
    printer.table([
      [{ text: 'warn', style: 'yellow' }, 'Service', 'stopped'],
      ['ok  ', 'Node', 'v24.14.0'],
    ]);
    const [coloured = '', plain = ''] = lines();
    expect(coloured).toMatch(ESCAPE);
    expect(visibleWidth(coloured.slice(0, coloured.indexOf('stopped')))).toBe(
      visibleWidth(plain.slice(0, plain.indexOf('v24.14.0')))
    );
  });
});

describe('a printer with no colour', () => {
  it('writes no escape byte at all, whatever it is asked to paint', () => {
    const { printer, lines } = collector(false);
    printer.title('switch-agent-controller status');
    printer.heading('Machine');
    printer.fields([{ label: 'Data directory', value: '/var/lib/controller' }]);
    printer.note('nothing pulled yet');
    printer.checks([
      { name: 'Service', status: 'warn', detail: 'Not installed.', fix: 'install-service' },
    ]);
    printer.line(printer.paint('painted', 'red'));
    const text = lines().join('\n');
    expect(text).not.toMatch(ESCAPE);
    expect(text).toContain('warn  Service  Not installed. Fix: install-service');
  });
});

describe('checks', () => {
  it('puts the fix on the same line as the problem, and omits it when there is none', () => {
    const { printer, lines } = collector(false);
    printer.checks([
      { name: 'Node', status: 'ok', detail: 'v24.14.0', fix: null },
      {
        name: 'Service',
        status: 'fail',
        detail: 'Not installed.',
        fix: 'switch-agent-controller install-service',
      },
    ]);
    expect(lines()).toEqual([
      '  ok    Node     v24.14.0',
      '  FAIL  Service  Not installed. Fix: switch-agent-controller install-service',
      '',
    ]);
  });
});

describe('json', () => {
  it('writes one document and nothing else, never coloured', () => {
    for (const color of [false, true]) {
      const { printer, lines } = collector(color);
      printer.json({ schema: 'switch-agent-controller/status@1', enrolled: true });
      const text = lines().join('\n');
      expect(text).not.toMatch(ESCAPE);
      expect(JSON.parse(text)).toEqual({
        schema: 'switch-agent-controller/status@1',
        enrolled: true,
      });
    }
  });
});
