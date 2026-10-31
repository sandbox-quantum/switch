import { describe, expect, it } from 'vitest';
import { ANSI_COLORS } from './report';
import { formatSnapshot, snapshotJson, type StatusSnapshot } from './snapshot';

const IDENTITY = {
  controllerId: 'controller-1',
  server: 'https://switch.example.com',
  name: 'box',
  enrolledAt: '2026-10-28T12:00:00.000Z',
};

const ENROLLED: StatusSnapshot = {
  version: '0.1.1',
  dataDir: '/var/lib/switch-agent-controller',
  separateUsers: null,
  identity: IDENTITY,
  revokedAt: null,
  secretStore: 'owner-only files',
  relayPort: 4400,
  credentialPresent: true,
  assignment: { kind: 'none' },
};

describe('formatSnapshot', () => {
  it('says only what it knows about a directory that is not enrolled', () => {
    const text = formatSnapshot({
      ...ENROLLED,
      identity: null,
      relayPort: null,
      credentialPresent: null,
    });
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0].startsWith('Data directory:')).toBe(true);
    expect(lines[0].endsWith('/var/lib/switch-agent-controller')).toBe(true);
    expect(lines[1]).toBe('Not enrolled.');
  });

  it('aligns the labels and keeps every value plain', () => {
    const lines = formatSnapshot(ENROLLED).split('\n');
    expect(lines).toHaveLength(7);
    // The longest label is 'Data directory:' (15), so every value starts at 17.
    const values = lines.map((line) => line.slice(17));
    expect(values[0]).toBe('/var/lib/switch-agent-controller');
    expect(values[1]).toBe('controller-1 ("box")');
    expect(values[2]).toBe('https://switch.example.com');
    expect(values[3]).toBe('2026-10-28T12:00:00.000Z');
    expect(values[4]).toBe('owner-only files');
    expect(values[5]).toBe('http://127.0.0.1:4400 (where agents were last pointed)');
    expect(values[6]).toBe('not pulled yet');
  });

  it('dims the labels and nothing else when coloured', () => {
    const first = formatSnapshot(ENROLLED, ANSI_COLORS).split('\n')[0];
    expect(first).toBe('\u001b[2mData directory:\u001b[0m  /var/lib/switch-agent-controller');
  });

  it('says a revoked controller and a missing credential each in their turn', () => {
    const revoked = formatSnapshot({
      ...ENROLLED,
      revokedAt: '2026-10-29T09:00:00.000Z',
      relayPort: null,
    }).split('\n');
    expect(revoked[6]).toMatch(/^Revoked at:\s+2026-10-29T09:00:00.000Z$/);
    const missing = formatSnapshot({
      ...ENROLLED,
      relayPort: null,
      credentialPresent: false,
    }).split('\n');
    expect(missing[6]).toMatch(
      /^Credential:\s+not in this data directory \(missing, or handed over at run time\)$/
    );
  });

  it('spells out an assignment an earlier version saved', () => {
    const lines = formatSnapshot({
      ...ENROLLED,
      assignment: { kind: 'unreadable', detail: 'not a valid assignment' },
    }).split('\n');
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe(
      'Assignment:      saved by an earlier version and not readable by this one (not a valid assignment); pulled again when the controller next runs'
    );
  });

  it('lists one block per agent, in line with the assignment it counted', () => {
    const text = formatSnapshot({
      ...ENROLLED,
      assignment: {
        kind: 'ok',
        revision: 3,
        agents: [
          {
            name: 'helper',
            id: 'agent-1',
            provider: 'claude',
            desired: 'running',
            revision: 3,
            applied: null,
            process: 'failed',
            reason: 'provider_login_expired',
            detail: 'claude: please sign in',
            note: null,
          },
          {
            name: 'writer',
            id: 'agent-2',
            provider: 'opencode',
            desired: 'stopped',
            revision: 2,
            applied: 2,
            process: 'stopped',
            reason: null,
            detail: null,
            note: "switch-agent@1.service is active; the rest needs the agents' group (permission)",
          },
        ],
      },
    });
    const lines = text.split('\n');
    expect(lines[6]).toBe('Assignment:      revision 3, 2 agent(s)');
    expect(lines.slice(7)).toEqual([
      '',
      '  helper (agent-1)',
      '    provider claude, desired running, revision 3, applied never',
      '    failed [provider_login_expired]: claude: please sign in',
      '',
      '  writer (agent-2)',
      '    provider opencode, desired stopped, revision 2, applied 2',
      "    switch-agent@1.service is active; the rest needs the agents' group (permission)",
    ]);
  });
});

describe('snapshotJson', () => {
  it('round-trips the snapshot a script would read', () => {
    const snapshot: StatusSnapshot = {
      ...ENROLLED,
      assignment: {
        kind: 'ok',
        revision: 3,
        agents: [
          {
            name: 'helper',
            id: 'agent-1',
            provider: 'claude',
            desired: 'running',
            revision: 3,
            applied: null,
            process: 'failed',
            reason: 'provider_login_expired',
            detail: 'claude: please sign in',
            note: null,
          },
        ],
      },
    };
    expect(JSON.parse(snapshotJson(snapshot))).toEqual(snapshot);
  });

  it('carries the version, for a script reading output from older ones', () => {
    expect(JSON.parse(snapshotJson(ENROLLED)).version).toBe('0.1.1');
  });
});
