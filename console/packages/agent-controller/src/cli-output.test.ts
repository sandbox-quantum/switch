import { describe, expect, it } from 'vitest';
import { checksOutput, colourEnabled, fields, type LocalStatus, statusOutput } from './cli-output';

describe('CLI output', () => {
  it('uses colour only on terminals that have not disabled it', () => {
    expect(colourEnabled(true, {})).toBe(true);
    expect(colourEnabled(false, {})).toBe(false);
    expect(colourEnabled(true, { NO_COLOR: '' })).toBe(false);
    expect(colourEnabled(true, { NO_COLOR: '1' })).toBe(false);
    expect(colourEnabled(true, { TERM: 'dumb' })).toBe(false);
  });

  it('aligns labels and handles empty sections', () => {
    expect(
      fields([
        ['A', 'one'],
        ['Long', 'two'],
      ])
    ).toBe('  A:     one\n  Long:  two');
    expect(fields([])).toBe('');
    expect(checksOutput([], false)).toBe('');
  });

  it('keeps diagnostic severity readable without colour', () => {
    const checks = [
      { name: 'Node', status: 'ok' as const, detail: 'v24' },
      { name: 'Service', status: 'warn' as const, detail: 'Start the service' },
      { name: 'Enrollment', status: 'fail' as const, detail: 'Enroll again' },
    ];
    expect(checksOutput(checks, false)).toBe(
      '  OK    Node        v24\n  WARN  Service     Start the service\n  FAIL  Enrollment  Enroll again'
    );
    expect(checksOutput(checks, true)).toContain('\x1b[31mFAIL\x1b[0m');
  });

  it('shows actionable enrollment guidance and agent observation failures', () => {
    const status: LocalStatus = {
      dataDir: '/example/controller',
      identity: null,
      secretStore: 'file',
      relayPort: null,
      revokedAt: null,
      credentialPresent: null,
      separateUsers: null,
      assignment: { kind: 'none', detail: null, revision: null },
      agents: [],
    };
    expect(statusOutput(status, false)).toContain('switch-agent-controller enroll');
    status.identity = {
      controllerId: 'controller-1',
      name: 'build-box',
      server: 'https://switch.example.com',
      enrolledAt: '2026-01-01',
    };
    status.assignment = { kind: 'saved', detail: null, revision: 2 };
    status.agents.push({
      id: 'agent-1',
      name: 'Helper',
      provider: 'claude',
      desiredState: 'running',
      revision: 2,
      appliedRevision: null,
      process: 'pending',
      reason: null,
      detail: null,
      observationError: 'Permission denied',
      unit: 'agent-1.service is active',
    });
    const plain = statusOutput(status, false);
    expect(plain).toContain('revision 2, 1 agent(s)');
    expect(plain).toContain('Helper (agent-1)');
    expect(plain).toContain(
      "agent-1.service is active; the rest needs the agents' group (Permission denied)"
    );
    expect(plain).not.toContain('\x1b[');
  });
});
