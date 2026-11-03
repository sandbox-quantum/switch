import { describe, expect, it } from 'vitest';
import type { ManagementController } from '@main/core/switch-servers/gateway-client';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  machineProvider,
  ownedMachines,
  preferredFirst,
  thisComputerReport,
} from './owned-machines';

function controller(patch: Partial<ManagementController> & { id: string }): ManagementController {
  return {
    name: patch.id,
    description: null,
    kind: 'daemon',
    state: 'online',
    lastSeenAt: null,
    revokedAt: null,
    providers: [],
    workspacesDir: null,
    os: null,
    sealingKey: null,
    ...patch,
  };
}

describe('machineProvider', () => {
  it('is ready only when installed and logged in', () => {
    expect(
      machineProvider({
        provider: 'claude',
        installed: true,
        auth: 'ok',
        problem: null,
        loginHelps: true,
      })
    ).toEqual({
      provider: 'claude',
      ready: true,
      problem: null,
      detail: null,
      loginHelps: true,
    });
  });

  it('says why a provider is not ready', () => {
    const problem = (installed: boolean, auth: 'ok' | 'expired' | 'missing' | 'unknown') =>
      machineProvider({ provider: 'codex', installed, auth, problem: null, loginHelps: true });
    expect(problem(false, 'ok')).toEqual({
      provider: 'codex',
      ready: false,
      problem: 'not installed',
      detail: null,
      loginHelps: true,
    });
    expect(problem(true, 'missing').problem).toBe('not logged in');
    expect(problem(true, 'expired').problem).toBe('login expired');
    expect(problem(true, 'unknown')).toEqual({
      provider: 'codex',
      ready: false,
      problem: 'login not checked yet',
      detail: null,
      loginHelps: true,
    });
  });

  it('stops waiting on a login the machine could not check, and says why', () => {
    expect(
      machineProvider({
        provider: 'claude',
        installed: true,
        auth: 'unknown',
        problem: 'Claude Code did not say whether it is signed in. It may be too old.',
        loginHelps: true,
      })
    ).toEqual({
      provider: 'claude',
      ready: false,
      problem: 'login could not be checked',
      detail: 'Claude Code did not say whether it is signed in. It may be too old.',
      loginHelps: true,
    });
  });

  it('passes on that signing in would not make a provider ready', () => {
    expect(
      machineProvider({
        provider: 'codex',
        installed: true,
        auth: 'missing',
        problem: 'An administrator pins where Codex keeps logins.',
        loginHelps: false,
      })
    ).toMatchObject({ ready: false, problem: 'not logged in', loginHelps: false });
  });
});

describe('ownedMachines', () => {
  it('lists every machine but the revoked ones, and says which are this computer or an SSH host', () => {
    const machines = ownedMachines(
      [
        controller({
          id: 'laptop',
          kind: 'console',
          providers: [
            { provider: 'claude', installed: true, auth: 'ok', problem: null, loginHelps: true },
          ],
          workspacesDir: '/data/workspaces',
          os: null,
        }),
        controller({ id: 'box', state: 'unknown' }),
        controller({ id: 'cloud-vm', sealingKey: { key: 'a2V5', keyId: 'id' } }),
        controller({ id: 'gone', state: 'revoked' }),
      ],
      { thisComputer: 'laptop', sshHosts: [{ controllerId: 'box', sshHost: 'devbox' }] }
    );
    expect(machines).toEqual([
      {
        id: 'laptop',
        name: 'laptop',
        kind: 'console',
        state: 'online',
        providers: [
          { provider: 'claude', ready: true, problem: null, detail: null, loginHelps: true },
        ],
        workspacesDir: '/data/workspaces',
        os: null,
        local: { kind: 'this-computer' },
        acceptsLogins: false,
        cloud: false,
      },
      {
        id: 'box',
        name: 'box',
        kind: 'daemon',
        state: 'unknown',
        providers: [],
        workspacesDir: null,
        os: null,
        local: { kind: 'ssh-host', sshHost: 'devbox' },
        acceptsLogins: false,
        cloud: false,
      },
      {
        id: 'cloud-vm',
        name: 'cloud-vm',
        kind: 'daemon',
        state: 'online',
        providers: [],
        workspacesDir: null,
        os: null,
        local: null,
        acceptsLogins: true,
        cloud: false,
      },
    ]);
  });

  it('marks the owner’s Switch cloud machine', () => {
    const [cloud] = ownedMachines([controller({ id: 'ec2', kind: 'ec2' })], {
      thisComputer: null,
      sshHosts: [],
    });
    expect(cloud?.cloud).toBe(true);
  });
});

describe('thisComputerReport', () => {
  const claude = { provider: 'claude', ready: true, problem: null, detail: null, loginHelps: true };
  function machine(patch: Partial<OwnedMachine>): OwnedMachine {
    return {
      id: 'mac',
      name: 'mac',
      kind: 'daemon',
      state: 'online',
      providers: [claude],
      acceptsLogins: false,
      cloud: false,
      workspacesDir: null,
      os: null,
      local: { kind: 'this-computer' },
      ...patch,
    };
  }

  it('takes what this computer reported to the first server that has a report', async () => {
    const machines: Record<string, OwnedMachine[] | null> = {
      'no-management': null,
      'not-reported': [machine({ providers: [] })],
      reported: [machine({ id: 'other', local: null }), machine({})],
    };
    expect(
      await thisComputerReport(Object.keys(machines), (id) => Promise.resolve(machines[id]!))
    ).toEqual({ serverId: 'reported', providers: [claude] });
  });

  it('skips a server it cannot ask, and an offline report that may be stale', async () => {
    const report = await thisComputerReport(['down', 'offline'], (id) =>
      id === 'down'
        ? Promise.reject(new Error('signed out'))
        : Promise.resolve([machine({ state: 'offline' })])
    );
    expect(report).toBeNull();
  });

  it('is null when this computer runs no controller', async () => {
    expect(await thisComputerReport([], () => Promise.resolve([machine({})]))).toBeNull();
  });
});

describe('preferredFirst', () => {
  it('asks the server Console is on first, then the rest in order', () => {
    expect(preferredFirst(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    expect(preferredFirst(['a', 'b'], 'elsewhere')).toEqual(['a', 'b']);
    expect(preferredFirst(['a', 'b'], null)).toEqual(['a', 'b']);
  });
});
