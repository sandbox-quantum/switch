import { describe, expect, it } from 'vitest';
import { type AgentStatusView, formatStatus, type StatusView, statusJson } from './status-output';

const CONTROLLER: NonNullable<StatusView['controller']> = {
  id: 'controller-1',
  name: 'build-box',
  server: 'https://switch.example.invalid',
  enrolledAt: '2026-10-01T00:00:00Z',
  secretStore: 'owner-only files in /data',
  relay: 'http://127.0.0.1:4100',
  revokedAt: null,
  credential: true,
};

function agent(overrides: Partial<AgentStatusView> = {}): AgentStatusView {
  return {
    id: 'agent-1',
    name: 'alice',
    provider: 'claude',
    desired: 'running',
    revision: 3,
    applied: 3,
    process: 'running',
    reason: null,
    detail: null,
    unreadable: null,
    ...overrides,
  };
}

function view(overrides: Partial<StatusView> = {}): StatusView {
  return {
    dataDir: '/data',
    separateUsers: null,
    controller: CONTROLLER,
    assignment: { state: 'pulled', revision: 7, agents: [agent()] },
    ...overrides,
  };
}

describe('formatStatus', () => {
  it('shows the machine, the controller and a table of agents', () => {
    expect(
      formatStatus(
        view({
          assignment: {
            state: 'pulled',
            revision: 7,
            agents: [
              agent(),
              agent({
                id: 'agent-2',
                name: 'bob',
                provider: 'codex',
                applied: null,
                process: 'failed',
                reason: 'provider_not_installed',
                detail: 'codex is not on PATH',
              }),
            ],
          },
        })
      )
    ).toBe(
      [
        'Machine',
        '  Data directory  /data',
        '',
        'Controller',
        '  ID            controller-1',
        '  Name          build-box',
        '  Server        https://switch.example.invalid',
        '  Enrolled at   2026-10-01T00:00:00Z',
        '  Secret store  owner-only files in /data',
        '  Relay         http://127.0.0.1:4100 (where agents were last pointed)',
        '',
        'Agents (revision 7, 2 agents)',
        '  NAME   ID       PROVIDER  DESIRED  APPLIED  STATE',
        '  alice  agent-1  claude    running  3/3      running',
        '  bob    agent-2  codex     running  never/3  failed [provider_not_installed]: codex is not on PATH',
      ].join('\n')
    );
  });

  it('says how to enroll a machine that is not enrolled', () => {
    const text = formatStatus(view({ controller: null, assignment: null }));
    expect(text).toContain('Not enrolled.');
    expect(text).toContain('switch-agent-controller enroll --server <url> --code <code>');
  });

  it('flags a revoked controller, and a credential that is not here', () => {
    expect(
      formatStatus(view({ controller: { ...CONTROLLER, revokedAt: '2026-10-02T00:00:00Z' } }))
    ).toContain('  Revoked at    2026-10-02T00:00:00Z');
    expect(formatStatus(view({ controller: { ...CONTROLLER, credential: false } }))).toMatch(
      /Credential +not in this data directory/
    );
  });

  it('explains an assignment not pulled yet, or one it cannot read', () => {
    expect(formatStatus(view({ assignment: { state: 'not-pulled' } }))).toContain(
      'Assignment not pulled yet.'
    );
    expect(
      formatStatus(view({ assignment: { state: 'unreadable', detail: 'schema 3' } }))
    ).toContain('(schema 3)');
  });

  it('names the separate-users setup, and what this shell cannot read of an agent', () => {
    const text = formatStatus(
      view({
        separateUsers: { agentsDir: '/srv/agents', controllerUnit: 'switch-controller.service' },
        assignment: {
          state: 'pulled',
          revision: 1,
          agents: [
            agent({
              unreadable: 'switch-agent@1.service is active; the rest needs the agents group',
            }),
          ],
        },
      })
    );
    expect(text).toContain('Agents run      each as a user of its own, in /srv/agents');
    expect(text).toContain('switch-agent@1.service is active');
  });

  it('colours only the state column, so the table stays aligned', () => {
    const plain = formatStatus(view());
    const coloured = formatStatus(view(), { color: true });
    expect(coloured).toContain('\u001b[');
    expect(coloured.replace(/\u001b\[\d+m/g, '')).toBe(plain);
  });
});

describe('statusJson', () => {
  it('prints the same view, with no colour', () => {
    const json = statusJson(view());
    expect(json).not.toContain('\u001b[');
    expect(JSON.parse(json)).toEqual(view());
  });
});
