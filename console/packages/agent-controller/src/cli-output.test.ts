import { stripVTControlCharacters } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  checkSummary,
  CliOutput,
  formatDoctor,
  formatStatus,
  plain,
  type StatusView,
} from './cli-output';
import type { Check } from './doctor';

const checks: Check[] = [
  { name: 'Node', status: 'ok', detail: 'v24.0.0' },
  { name: 'Service', status: 'warn', detail: 'Not installed', fix: 'Run install-service.' },
  { name: 'Enrollment', status: 'fail', detail: 'Not enrolled', fix: 'Get a code from Machines.' },
  { name: 'claude', status: 'ok', detail: 'Signed in' },
];

const view: StatusView = {
  version: '0.1.1',
  platform: 'linux',
  dataDir: '/data',
  identity: {
    controllerId: 'controller-1',
    name: 'build-box',
    server: 'https://switch.example',
    enrolledAt: '2026-10-29T00:00:00Z',
  },
  agentUsers: null,
  secretStore: 'file',
  relayPort: null,
  revokedAt: null,
  credential: 'present',
  assignment: { state: 'ready', revision: 3, detail: null },
  agents: [],
};

describe('CLI formatting', () => {
  it.each([
    [{}, {}],
    [{ isTTY: false }, {}],
    [{ isTTY: true }, { NO_COLOR: '' }],
    [{ isTTY: true }, { NO_COLOR: '1' }],
    [{ isTTY: true }, { TERM: 'dumb' }],
    [{ isTTY: false }, { FORCE_COLOR: '1' }],
  ])('prints plain output for stream %j and environment %j', (stream, env) => {
    const output = new CliOutput(stream, env);
    const text =
      formatDoctor(checks, output) +
      formatStatus(view, output) +
      output.help('Usage: example\n  status\n');
    expect(text).not.toContain('\u001b');
    expect(text).toContain('[WARN]');
  });

  it('adds color only on a capable terminal, preserving the plain layout', () => {
    const colored = formatDoctor(checks, new CliOutput({ isTTY: true }, { TERM: 'xterm' }));
    expect(colored).toContain('\u001b[33m');
    expect(stripVTControlCharacters(colored)).toBe(formatDoctor(checks, new CliOutput({}, {})));
  });

  it('aligns labels and check names independently of the severity', () => {
    const output = new CliOutput({}, {});
    const rows = output
      .section('Machine', [
        ['ID', 'one'],
        ['Directory', '/data'],
      ])
      .split('\n');
    expect(rows[1]!.indexOf('one')).toBe(rows[2]!.indexOf('/data'));
    const lines = formatDoctor(checks, output).split('\n');
    expect(lines.find((s) => s.includes('[OK]') && s.includes('Node'))!.indexOf('Node')).toBe(
      lines.find((s) => s.includes('[WARN]') && s.includes('Service'))!.indexOf('Service')
    );
  });

  it('shows fixes and an accurate summary, including an empty result', () => {
    const text = formatDoctor(checks, new CliOutput({}, {}));
    expect(text).toContain('Machine\n');
    expect(text).toContain('Connection\n');
    expect(text).toContain('Providers\n');
    expect(text).toContain('Fix: Run install-service.');
    expect(text).toContain('2 ok, 1 warning, 1 failed');
    expect(checkSummary(checks)).toEqual({ ok: 2, warn: 1, fail: 1 });
    expect(formatDoctor([], new CliOutput({}, {}))).toBe('0 ok, 0 warnings, 0 failed');
  });

  it('shows empty agents and explains incomplete state without claiming readiness', () => {
    const output = new CliOutput({}, {});
    expect(formatStatus(view, output)).toContain('No agents assigned.');
    expect(formatStatus({ ...view, identity: null }, output)).toContain('Not enrolled.');
    expect(
      formatStatus(
        { ...view, assignment: { state: 'unreadable', revision: null, detail: 'old format' } },
        output
      )
    ).toContain('Saved assignment is unreadable (old format)');
    expect(formatStatus({ ...view, revokedAt: '2026-10-29' }, output)).toContain('[FAIL]');
    expect(formatStatus({ ...view, credential: 'missing' }, output)).toContain(
      'Credential missing'
    );
  });

  it('keeps agent identity, provider, revisions and observation failures visible', () => {
    const text = formatStatus(
      {
        ...view,
        agents: [
          {
            id: 'agent-1',
            name: 'scout',
            provider: 'claude',
            desired: 'running',
            revision: 3,
            appliedRevision: 2,
            process: 'unknown',
            reason: null,
            detail: null,
            observationProblem: 'Needs the agents group',
          },
        ],
      },
      new CliOutput({}, {})
    );
    for (const value of [
      'scout',
      'agent-1',
      'claude',
      '3 (applied 2)',
      'unknown',
      'Needs the agents group',
    ])
      expect(text).toContain(value);
  });

  it('removes terminal escapes and line injection from untrusted labels and results', () => {
    expect(plain('\u001b[31mred\u001b[0m\nnext\r\u0007')).toBe('red next  ');
    expect(plain('\u001b]8;;https://example.invalid\u0007link\u001b]8;;\u0007')).toBe('link');
    const output = new CliOutput({}, {});
    expect(output.section('Bad\nHeading', [['Key', '\u001b[2Jvalue\nspoof']])).toBe(
      'Bad Heading\n  Key  value spoof'
    );
  });
});
