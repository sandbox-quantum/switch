import { describe, expect, it } from 'vitest';
import type { Check } from './doctor';
import {
  formatDoctorChecks,
  formatEnrollSuccess,
  formatStatusDocument,
  isColorEnabled,
  mark,
  type StatusDocument,
  SYMBOLS,
} from './format';

describe('format utilities', () => {
  it('detects color support correctly', () => {
    const origNoColor = process.env.NO_COLOR;
    const origTerm = process.env.TERM;
    try {
      process.env.NO_COLOR = '1';
      expect(isColorEnabled({ isTTY: true } as any)).toBe(false);

      delete process.env.NO_COLOR;
      process.env.TERM = 'dumb';
      expect(isColorEnabled({ isTTY: true } as any)).toBe(false);

      process.env.TERM = 'xterm-256color';
      expect(isColorEnabled({ isTTY: false } as any)).toBe(false);
      expect(isColorEnabled({ isTTY: true } as any)).toBe(true);
    } finally {
      process.env.NO_COLOR = origNoColor;
      process.env.TERM = origTerm;
    }
  });

  it('renders status marks with and without color', () => {
    expect(mark('ok', false)).toBe(`${SYMBOLS.ok} ok  `);
    expect(mark('warn', false)).toBe(`${SYMBOLS.warn} warn`);
    expect(mark('fail', false)).toBe(`${SYMBOLS.fail} FAIL`);

    expect(mark('ok', true)).toContain('\x1b[');
    expect(mark('warn', true)).toContain('\x1b[');
    expect(mark('fail', true)).toContain('\x1b[');
  });

  it('formats doctor checks cleanly in plain text without ANSI codes', () => {
    const checks: Check[] = [
      { name: 'Node', status: 'ok', detail: 'v22.13.0' },
      { name: 'Server', status: 'warn', detail: 'latency is high' },
      { name: 'Providers', status: 'fail', detail: 'no CLI found' },
    ];

    const output = formatDoctorChecks(checks, { color: false });
    expect(output).not.toContain('\x1b[');
    expect(output).toContain(`${SYMBOLS.ok} ok    Node        v22.13.0`);
    expect(output).toContain(`${SYMBOLS.warn} warn  Server      latency is high`);
    expect(output).toContain(`${SYMBOLS.fail} FAIL  Providers   no CLI found`);
    expect(output).toContain('Summary: 1 ok, 1 warning, 1 failure');
  });

  it('formats status document with agents in plain text', () => {
    const doc: StatusDocument = {
      controller: {
        id: 'ctrl_123',
        name: 'test-box',
        server: 'https://switch.test',
        enrolledAt: '2026-11-06T12:00:00Z',
        revokedAt: null,
        dataDir: '/var/data',
        secretStore: 'File in /var/data/secrets',
        relayPort: 42000,
        credentialPresent: true,
      },
      assignment: {
        status: 'ready',
        revision: 2,
        agentsCount: 1,
      },
      agents: [
        {
          id: 'agent_1',
          name: 'Code Reviewer',
          provider: 'claude',
          desiredState: 'running',
          revision: 2,
          appliedRevision: 2,
          mapped: {
            process: 'running',
            detail: 'pid 1234',
          },
        },
      ],
    };

    const output = formatStatusDocument(doc, { color: false });
    expect(output).not.toContain('\x1b[');
    expect(output).toContain('Controller Machine');
    expect(output).toContain('ctrl_123');
    expect(output).toContain('Code Reviewer');
    expect(output).toContain('pid 1234');
  });

  it('formats enroll confirmation cleanly', () => {
    const output = formatEnrollSuccess(
      {
        controllerId: 'ctrl_abc',
        name: 'dev-box',
        server: 'https://switch.local',
        dataDir: '/data',
      },
      { color: false }
    );

    expect(output).not.toContain('\x1b[');
    expect(output).toContain('Enrolled successfully as controller ctrl_abc');
    expect(output).toContain('switch-agent-controller install-service');
  });
});
