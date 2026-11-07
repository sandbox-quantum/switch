import { describe, expect, it } from 'vitest';
import type { Check } from './doctor';
import {
  ANSI_COLORS,
  colorsFor,
  doctorJson,
  formatChecks,
  formatUsage,
  MARK,
  NO_COLORS,
  renderFields,
} from './report';

const CHECKS: Check[] = [
  { name: 'Node', status: 'ok', detail: 'v24.14.0' },
  { name: 'Providers', status: 'fail', detail: 'No provider CLI is signed in' },
  { name: 'Service', status: 'warn', detail: 'Not installed' },
];

describe('colorsFor', () => {
  it('colours for a terminal', () => {
    expect(colorsFor({ isTTY: true }, {})).toBe(ANSI_COLORS);
    expect(colorsFor({ isTTY: true }, {}).ok('fine')).toBe('\u001b[32mfine\u001b[0m');
  });

  it('stays plain for a pipe, or whenever NO_COLOR is set to anything', () => {
    expect(colorsFor({ isTTY: false }, {})).toBe(NO_COLORS);
    expect(colorsFor({}, {})).toBe(NO_COLORS);
    expect(colorsFor({ isTTY: true }, { NO_COLOR: '' })).toBe(NO_COLORS);
    expect(colorsFor({ isTTY: true }, { NO_COLOR: '0' })).toBe(NO_COLORS);
    expect(colorsFor({ isTTY: true }, { NO_COLOR: '1' }).fail('FAIL')).toBe('FAIL');
  });
});

describe('MARK', () => {
  it('keeps the mark column four characters wide', () => {
    expect(MARK.ok).toHaveLength(4);
    expect(MARK.warn).toHaveLength(4);
    expect(MARK.fail).toHaveLength(4);
  });
});

describe('formatChecks', () => {
  it('aligns the names and keeps the detail plain', () => {
    const text = formatChecks(CHECKS);
    expect(text.split('\n')).toEqual([
      'ok    Node       v24.14.0',
      'FAIL  Providers  No provider CLI is signed in',
      'warn  Service    Not installed',
    ]);
  });

  it('paints only the mark', () => {
    const lines = formatChecks(CHECKS, ANSI_COLORS).split('\n');
    expect(lines[0]).toBe(`\u001b[32m${MARK.ok}\u001b[0m  Node       v24.14.0`);
    expect(lines[1]).toBe(
      `\u001b[31m${MARK.fail}\u001b[0m  Providers  No provider CLI is signed in`
    );
    expect(lines[2]).toBe(`\u001b[33m${MARK.warn}\u001b[0m  Service    Not installed`);
  });
});

describe('doctorJson', () => {
  it('carries every check', () => {
    const parsed = JSON.parse(doctorJson('0.1.1', 'v24.14.0', CHECKS));
    expect(parsed).toEqual({
      version: '0.1.1',
      node: 'v24.14.0',
      checks: CHECKS,
    });
  });
});

describe('renderFields', () => {
  it('aligns the labels', () => {
    const lines = renderFields([
      ['Data directory:', '/var/lib/switch'],
      ['Relay:', 'never started'],
    ]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('Data directory:')).toBe(true);
    expect(lines[1].startsWith('Relay:')).toBe(true);
    // The longest label is 15 characters, so both values start at column 17.
    expect(lines[0].indexOf('/var/lib/switch')).toBe(17);
    expect(lines[1].indexOf('never started')).toBe(17);
  });

  it('dims the label and nothing else when coloured', () => {
    expect(renderFields([['Relay:', 'never started']], ANSI_COLORS)).toBe(
      '\u001b[2mRelay:\u001b[0m  never started'
    );
  });
});

describe('formatUsage', () => {
  const USAGE = `Usage: switch-agent-controller <command> [options]

Commands:
  enroll --server <url>
      Enroll this machine.
  status [--json]
      Show this controller's identity.
  run [--data-dir <dir>]
      More words here.
`;

  it('leaves the text unchanged without colour', () => {
    expect(formatUsage(USAGE)).toBe(USAGE);
  });

  it('sets off the command words and nothing else', () => {
    const text = formatUsage(USAGE, ANSI_COLORS);
    expect(text).toContain('\n  \u001b[1menroll\u001b[0m --server <url>');
    expect(text).toContain('\n  \u001b[1mstatus\u001b[0m [--json]');
    expect(text).toContain('\n  \u001b[1mrun\u001b[0m [--data-dir <dir>]');
    expect(text).not.toContain('\u001b[1mEnroll');
    expect(text).not.toContain('\u001b[1m      ');
  });
});
