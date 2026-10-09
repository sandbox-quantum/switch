import { describe, expect, it } from 'vitest';
import type { ManagementController } from '@main/core/switch-servers/gateway-client';
import { machineProvider, ownedMachines } from './owned-machines';

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
    sealingKey: null,
    ...patch,
  };
}

describe('machineProvider', () => {
  it('is ready only when installed and logged in', () => {
    expect(machineProvider({ provider: 'claude', installed: true, auth: 'ok' })).toEqual({
      provider: 'claude',
      ready: true,
      problem: null,
    });
  });

  it('says why a provider is not ready', () => {
    const problem = (installed: boolean, auth: 'ok' | 'expired' | 'missing' | 'unknown') =>
      machineProvider({ provider: 'codex', installed, auth });
    expect(problem(false, 'ok')).toEqual({
      provider: 'codex',
      ready: false,
      problem: 'not installed',
    });
    expect(problem(true, 'missing').problem).toBe('not logged in');
    expect(problem(true, 'expired').problem).toBe('login expired');
    expect(problem(true, 'unknown')).toEqual({
      provider: 'codex',
      ready: false,
      problem: 'login not checked yet',
    });
  });
});

describe('ownedMachines', () => {
  it('lists every machine but the revoked ones, and says which are this computer or an SSH host', () => {
    const machines = ownedMachines(
      [
        controller({
          id: 'laptop',
          kind: 'console',
          providers: [{ provider: 'claude', installed: true, auth: 'ok' }],
          workspacesDir: '/data/workspaces',
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
        providers: [{ provider: 'claude', ready: true, problem: null }],
        workspacesDir: '/data/workspaces',
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
