import { describe, expect, it } from 'vitest';
import type { ParsedAgentEntry } from '@main/core/agent-templates/template-document';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import type { ConnectionCatalogEntry } from '@shared/core/switch-servers/connection-catalog';
import {
  connectionStates,
  connectionsFor,
  directoryUnresolved,
  machineFor,
  machineProblem,
  managedDirectory,
  runAgent,
  shownDirectory,
} from './managed-run';

function machine(overrides: Partial<OwnedMachine>): OwnedMachine {
  return {
    id: 'm1',
    name: 'laptop',
    kind: 'console',
    state: 'online',
    providers: [{ provider: 'claude', ready: true, problem: null, detail: null, loginHelps: true }],
    acceptsLogins: true,
    cloud: false,
    workspacesDir: '/home/me/.switch/agents',
    os: 'linux',
    local: { kind: 'this-computer' },
    ...overrides,
  };
}

function entry(overrides: Partial<ParsedAgentEntry>): ParsedAgentEntry {
  return {
    name: 'a',
    displayName: null,
    description: '',
    instructions: 'Do it.',
    repoUrl: null,
    sources: [],
    addressing: null,
    provider: 'claude',
    location: null,
    machine: null,
    model: null,
    advancedConfig: {},
    isolation: null,
    autoMode: null,
    autoApprove: null,
    connections: [],
    directory: null,
    join: [],
    placeholders: [],
    allowExisting: false,
    key: null,
    condition: null,
    ...overrides,
  };
}

const LAPTOP = machine({});
const BOX = machine({
  id: 'm2',
  name: 'box',
  state: 'offline',
  local: { kind: 'ssh-host', sshHost: 'box.lan' },
});

describe('machineFor', () => {
  it('finds a machine by id or by name', () => {
    expect(machineFor([LAPTOP, BOX], 'm2', null, false)).toBe(BOX);
    expect(machineFor([LAPTOP, BOX], 'laptop', null, false)).toBe(LAPTOP);
  });

  it('puts a location that is no machine on the first online one that can run it', () => {
    const coder = machine({
      id: 'm4',
      name: 'cluster',
      providers: [
        { provider: 'codex', ready: true, problem: null, detail: null, loginHelps: true },
      ],
    });
    // "local" or an SSH host is this Console's idea: the server's $first stands in.
    expect(machineFor([BOX, coder, LAPTOP], 'local', 'claude', true)).toBe(LAPTOP);
    expect(machineFor([BOX, coder, LAPTOP], 'dev-vm', 'codex', true)).toBe(coder);
    expect(machineFor([BOX], 'local', 'claude', true)).toBeNull();
  });

  it('does not replace a machine the template names', () => {
    expect(machineFor([LAPTOP], 'nowhere', 'claude', false)).toBeNull();
    expect(machineFor([LAPTOP, machine({ id: 'm3' })], 'laptop', null, false)).toBeNull();
  });
});

describe('machineProblem', () => {
  it('says when the machine cannot take the agent', () => {
    expect(machineProblem(BOX, 'claude', 'a')).toMatch(/box is offline/);
    expect(machineProblem(LAPTOP, 'codex', 'a')).toBe('codex is not installed on laptop.');
    expect(
      machineProblem(
        machine({
          providers: [
            {
              provider: 'claude',
              ready: false,
              problem: 'not logged in',
              detail: null,
              loginHelps: true,
            },
          ],
        }),
        'claude',
        'a'
      )
    ).toBe('claude on laptop is not ready: not logged in.');
    expect(
      machineProblem(
        machine({
          providers: [
            {
              provider: 'claude',
              ready: false,
              problem: 'not logged in',
              detail: 'Its login is in the OS keyring.',
              loginHelps: true,
            },
          ],
        }),
        'claude',
        'a'
      )
    ).toBe('claude on laptop is not ready: not logged in. Its login is in the OS keyring.');
    expect(machineProblem(LAPTOP, 'claude', 'a')).toBeNull();
  });
});

describe('connectionsFor', () => {
  it('grants what the template lists, and nothing for a repo', () => {
    expect(
      connectionsFor(
        entry({
          repoUrl: 'https://github.com/acme/widgets.git',
          connections: [{ service: 'github', access: 'write', repos: ['acme/{repo}'] }],
        }),
        { repo: 'tools' }
      )
    ).toEqual([{ service: 'github', access: 'write', repos: ['acme/tools'] }]);
    expect(connectionsFor(entry({ repoUrl: 'https://github.com/acme/widgets' }), {})).toEqual([]);
  });
});

describe('connectionStates', () => {
  const catalog = [
    { slug: 'github', name: 'GitHub', status: 'connected', unavailable_reason: null },
    { slug: 'atlassian', name: 'Atlassian', status: 'not_connected', unavailable_reason: null },
  ] as ConnectionCatalogEntry[];

  it('says whether the deployer can grant each connection', () => {
    const states = connectionStates(
      [
        { service: 'github', access: null, repos: ['acme/widgets'] },
        { service: 'atlassian', access: null, repos: [] },
        { service: 'nope', access: null, repos: [] },
      ],
      catalog
    );
    expect(states.map((s) => [s.name, s.ready, s.note])).toEqual([
      ['GitHub', true, null],
      ['Atlassian', false, 'Connect Atlassian under Connectors first.'],
      ['nope', false, 'This server has no such connection.'],
    ]);
  });
});

describe('directories', () => {
  it('keeps {$agents_dir} for the server and fills the rest', () => {
    const directory = managedDirectory('{$agents_dir}/{team}/{agent}', { team: 'red' }, 'a');
    expect(directory).toBe('{$agents_dir}/red/a');
    expect(directoryUnresolved(directory)).toBe(false);
    expect(directoryUnresolved(managedDirectory('{root}/a', {}, 'a'))).toBe(true);
    expect(shownDirectory(directory, LAPTOP)).toBe('/home/me/.switch/agents/red/a');
  });
});

describe('runAgent', () => {
  it('sends the agent as the server takes it', () => {
    const agent = runAgent({
      slot: 'red-a',
      name: 'red-a',
      entry: entry({
        description: 'Works on {team}',
        model: '{model}',
        advancedConfig: { effort: '{effort}' },
        isolation: 'isolated',
        autoMode: false,
        autoApprove: '{yolo}',
        addressing: 'owner-agents',
        repoUrl: 'https://github.com/acme/widgets',
      }),
      values: { team: 'red', model: 'sonnet', effort: 'high', yolo: true },
      displayName: null,
      provider: 'claude',
      machine: LAPTOP,
      directoryText: '{$agents_dir}/red-a',
    });
    expect(agent).toMatchObject({
      description: 'Works on red',
      machine: 'm1',
      model: 'sonnet',
      advancedConfig: { effort: 'high' },
      isolation: 'isolated',
      autoMode: false,
      autoApprove: true,
      directory: null,
      addressing: 'owner-agents',
      connections: [],
    });
    expect(agent.instructions).toContain('clone https://github.com/acme/widgets into it');
  });

  it('sends the default addressing for an agent whose entry names none', () => {
    const agent = runAgent({
      slot: 'red-a',
      name: 'red-a',
      entry: entry({}),
      values: {},
      displayName: null,
      provider: 'claude',
      machine: LAPTOP,
      directoryText: '{$agents_dir}/red-a',
    });
    expect(agent.addressing).toBe('owner-agents');
  });

  it('runs a new agent in auto mode with bypass off unless its entry says otherwise', () => {
    const agent = runAgent({
      slot: 'red-a',
      name: 'red-a',
      entry: entry({}),
      values: {},
      displayName: null,
      provider: 'claude',
      machine: LAPTOP,
      directoryText: '{$agents_dir}/red-a',
    });
    expect(agent).toMatchObject({ autoMode: true, autoApprove: false });
  });
});
