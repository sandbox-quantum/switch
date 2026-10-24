import { describe, expect, it } from 'vitest';
import { PLAIN } from './format';
import {
  type AgentStatusView,
  formatStatus,
  processMark,
  type StatusView,
  statusJson,
} from './status-view';

function agent(overrides: Partial<AgentStatusView> = {}): AgentStatusView {
  return {
    id: 'agent-1',
    name: 'reviewer',
    provider: 'claude',
    desiredState: 'running',
    revision: 3,
    appliedRevision: 3,
    process: 'running',
    reason: null,
    detail: null,
    unit: null,
    ...overrides,
  };
}

function view(agents: AgentStatusView[]): StatusView {
  return {
    dataDir: '/data',
    separateUsers: null,
    controller: {
      id: 'controller-1',
      name: 'build-box',
      server: 'https://switch.example.invalid',
      enrolledAt: '2026-10-01T00:00:00Z',
      secretStore: 'files in /data/secrets',
      relayPort: 41000,
      revokedAt: null,
      credentialStored: true,
      assignment: { state: 'pulled', revision: 7, agents },
    },
  };
}

describe('formatStatus', () => {
  it('prints Machine, Controller and Agents, with aligned labels', () => {
    const text = formatStatus(PLAIN, view([agent()]));
    expect(text).toBe(
      [
        'Machine',
        '  Data directory:  /data',
        '',
        'Controller',
        '  Controller:    controller-1 ("build-box")',
        '  Server:        https://switch.example.invalid',
        '  Enrolled at:   2026-10-01T00:00:00Z',
        '  Secret store:  files in /data/secrets',
        '  Relay:         http://127.0.0.1:41000 (where agents were last pointed)',
        '',
        'Agents (revision 7, 1 agent)',
        '  ok    reviewer (agent-1)',
        '        running, claude, desired running, revision 3, applied 3',
      ].join('\n')
    );
  });

  it('flags a failed agent and shows why', () => {
    const text = formatStatus(
      PLAIN,
      view([
        agent({
          process: 'failed',
          reason: 'invalid_credential',
          detail: 'The provider rejected its sign-in.',
          appliedRevision: null,
        }),
      ])
    );
    expect(text).toContain('  FAIL  reviewer (agent-1)');
    expect(text).toContain(
      'failed [invalid_credential], claude, desired running, revision 3, applied never'
    );
    expect(text).toContain('        The provider rejected its sign-in.');
  });

  it('says how to enroll when the machine is not', () => {
    const text = formatStatus(PLAIN, { dataDir: '/data', separateUsers: null, controller: null });
    expect(text).toContain('  FAIL  Not enrolled.');
    expect(text).toContain('Fix: switch-agent-controller enroll --server <url> --code <code>');
  });

  it('notes a missing credential, and a revocation in its place', () => {
    const missing = view([]);
    missing.controller!.credentialStored = false;
    expect(formatStatus(PLAIN, missing)).toContain('  Credential:    not in this data directory');
    expect(formatStatus(PLAIN, missing)).toContain('  None assigned to this machine.');
    const revoked = view([]);
    revoked.controller!.revokedAt = '2026-10-02T00:00:00Z';
    revoked.controller!.credentialStored = null;
    const text = formatStatus(PLAIN, revoked);
    expect(text).toContain('  Revoked at:    2026-10-02T00:00:00Z');
    expect(text).not.toContain('Credential');
  });

  it('keeps `Revoked at:`, which the hosted machine boot looks for', () => {
    const revoked = view([]);
    revoked.controller!.revokedAt = '2026-10-02T00:00:00Z';
    for (const out of [PLAIN, { rich: true }])
      expect(formatStatus(out, revoked)).toContain('Revoked at:');
    expect(formatStatus(PLAIN, view([]))).not.toContain('Revoked at:');
  });

  it('colours only rich output', () => {
    expect(formatStatus(PLAIN, view([agent()]))).not.toMatch(/\u001b\[/);
    expect(formatStatus({ rich: true }, view([agent()]))).toMatch(/\u001b\[/);
  });
});

describe('processMark', () => {
  it('reads running and stopped as fine, failures as failed, the rest as in between', () => {
    expect(processMark('running')).toBe('ok');
    expect(processMark('stopped')).toBe('ok');
    expect(processMark('failed')).toBe('fail');
    expect(processMark('crashed')).toBe('fail');
    expect(processMark('pending')).toBe('warn');
    expect(processMark('starting')).toBe('warn');
  });
});

describe('statusJson', () => {
  it('is the view itself, so text and JSON cannot disagree', () => {
    const v = view([agent()]);
    expect(JSON.parse(statusJson(v))).toEqual(v);
  });
});
