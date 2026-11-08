import { describe, expect, it } from 'vitest';
import { createStyle } from './cli-output';
import {
  type AgentLine,
  ENROLL_HINT,
  formatLocalStatus,
  type LocalStatus,
  localStatusJson,
} from './local-status';

const plain = createStyle(false);
const ESC = String.fromCharCode(27);

const agent = (overrides: Partial<AgentLine>): AgentLine => ({
  id: 'agent-1',
  name: 'code-reviewer',
  provider: 'claude',
  desiredState: 'running',
  revision: 5,
  appliedRevision: 5,
  process: 'running',
  reason: null,
  detail: null,
  ...overrides,
});

function status(overrides: Partial<LocalStatus> = {}): LocalStatus {
  return {
    dataDir: '/data',
    agentUsers: null,
    controller: {
      id: 'controller-1',
      name: 'build-box',
      server: 'https://switch.example.invalid',
      enrolledAt: '2026-11-04T09:30:00.000Z',
      secretStore: 'test store',
      relayPort: 41873,
      revokedAt: null,
      credentialMissing: false,
    },
    assignment: { kind: 'cached', revision: 7, agents: [agent({})] },
    ...overrides,
  };
}

describe('formatLocalStatus', () => {
  it('lays the machine, the controller and its agents out in sections', () => {
    expect(formatLocalStatus(status(), plain)).toBe(
      [
        'Machine',
        '  Data directory: /data',
        '',
        'Controller',
        '  ID:           controller-1',
        '  Name:         build-box',
        '  Server:       https://switch.example.invalid',
        '  Enrolled at:  2026-11-04T09:30:00.000Z',
        '  Secret store: test store',
        '  Relay:        http://127.0.0.1:41873 (where agents were last pointed)',
        '',
        'Agents (assignment revision 7)',
        '  AGENT          PROVIDER  DESIRED  PROCESS  REVISION  APPLIED',
        '  code-reviewer  claude    running  running  5         5',
        '    ID: agent-1',
      ].join('\n')
    );
  });

  it('says how to enroll when there is no enrollment', () => {
    const text = formatLocalStatus(
      status({ controller: null, assignment: { kind: 'none' } }),
      plain
    );
    expect(text).toContain('Not enrolled.');
    expect(text).toContain(ENROLL_HINT);
    expect(text).not.toContain('Controller');
  });

  it('keeps the "Revoked at:" line the hosted machine boot reads off a plain status', () => {
    const revoked = status();
    revoked.controller = { ...revoked.controller!, revokedAt: '2026-11-05T00:00:00.000Z' };
    expect(formatLocalStatus(revoked, plain)).toContain('Revoked at:');
    expect(formatLocalStatus(status(), plain)).not.toContain('Revoked at:');
  });

  it('says a credential is missing only when the enrollment is not revoked', () => {
    const missing = status();
    missing.controller = { ...missing.controller!, credentialMissing: true };
    expect(formatLocalStatus(missing, plain)).toContain('Credential:');
  });

  it('shows how agents run when each has a user of its own', () => {
    const text = formatLocalStatus(
      status({
        agentUsers: { agentsDir: '/srv/agents', controllerUnit: 'switch-controller.service' },
      }),
      plain
    );
    expect(text).toContain(
      'Agents run as:  each a user of its own, in /srv/agents (switch-controller.service)'
    );
  });

  it('puts what is wrong with an agent under it, with its reason code', () => {
    const text = formatLocalStatus(
      status({
        assignment: {
          kind: 'cached',
          revision: 7,
          agents: [
            agent({
              id: 'agent-4',
              name: 'ops-helper',
              provider: 'cursor',
              process: 'failed',
              reason: 'provider_login_missing',
              detail: 'cursor is not signed in.',
              appliedRevision: null,
            }),
          ],
        },
      }),
      plain
    );
    expect(text).toContain('ops-helper');
    expect(text).toContain('never');
    expect(text).toContain('  [provider_login_missing] cursor is not signed in.');
  });

  it('says what an empty, unpulled or unreadable assignment means', () => {
    expect(
      formatLocalStatus(status({ assignment: { kind: 'cached', revision: 3, agents: [] } }), plain)
    ).toContain('None assigned to this machine.');
    expect(formatLocalStatus(status({ assignment: { kind: 'none' } }), plain)).toContain(
      'Assignment not pulled yet'
    );
    expect(
      formatLocalStatus(status({ assignment: { kind: 'unreadable', detail: 'bad json' } }), plain)
    ).toContain('not readable by this one (bad json)');
  });

  it('writes no escape codes without colour, and colours the process with it', () => {
    const failing = status({
      assignment: {
        kind: 'cached',
        revision: 7,
        agents: [
          agent({ process: 'failed', reason: 'internal', detail: 'It stopped.' }),
          agent({ id: 'agent-2', process: 'running' }),
          agent({ id: 'agent-3', process: 'pending' }),
          agent({ id: 'agent-5', process: 'stopped' }),
        ],
      },
    });
    expect(formatLocalStatus(failing, plain)).not.toContain(ESC);
    const colored = formatLocalStatus(failing, createStyle(true));
    expect(colored).toContain(`${ESC}[31mfailed`);
    expect(colored).toContain(`${ESC}[32mrunning`);
    expect(colored).toContain(`${ESC}[33mpending`);
    expect(colored.replaceAll(/\u001b\[\d+m/g, '')).toBe(formatLocalStatus(failing, plain));
  });
});

describe('localStatusJson', () => {
  it('writes the same facts as one document that says whether this is enrolled', () => {
    const parsed = JSON.parse(localStatusJson(status()));
    expect(parsed).toMatchObject({
      enrolled: true,
      dataDir: '/data',
      controller: { id: 'controller-1', relayPort: 41873, revokedAt: null },
      assignment: { kind: 'cached', revision: 7, agents: [{ id: 'agent-1', process: 'running' }] },
    });
    expect(
      JSON.parse(localStatusJson(status({ controller: null, assignment: { kind: 'none' } })))
    ).toMatchObject({
      enrolled: false,
      controller: null,
    });
  });
});
