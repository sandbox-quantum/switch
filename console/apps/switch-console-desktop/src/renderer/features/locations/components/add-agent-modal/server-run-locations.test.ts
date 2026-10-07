import { describe, expect, it, vi } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  addSwitchCloudAgent,
  machineFor,
  machineIdOf,
  machineRunLocation,
  machineRunLocations,
  reconciledRunLocation,
  sshHostIsMachine,
  switchCloudMachine,
  thisComputerIsMachine,
} from './server-run-locations';

function machine(patch: Partial<OwnedMachine> & { id: string }): OwnedMachine {
  return {
    name: patch.id,
    kind: 'daemon',
    state: 'online',
    providers: [],
    local: null,
    workspacesDir: null,
    ...patch,
  };
}

const MACHINES = [
  machine({ id: 'vm', name: 'cloud-vm' }),
  machine({ id: 'box', name: 'devbox', local: { kind: 'ssh-host', sshHost: 'devbox' } }),
  machine({ id: 'laptop', name: 'laptop', kind: 'console', local: { kind: 'this-computer' } }),
  machine({ id: 'old', name: 'old-pc', kind: 'console', state: 'unknown' }),
];

describe('the run locations a server with agent management offers', () => {
  it('lists every machine, this computer first, offline ones shown but not pickable', () => {
    expect(machineRunLocations(MACHINES)).toEqual([
      {
        value: 'machine:laptop',
        label: 'This computer',
        tag: 'this Console',
        icon: 'monitor',
        disabled: false,
      },
      { value: 'machine:vm', label: 'cloud-vm', tag: 'daemon', icon: 'server', disabled: false },
      { value: 'machine:box', label: 'devbox', tag: 'ssh', icon: 'server', disabled: false },
      {
        value: 'machine:old',
        label: 'old-pc (offline)',
        tag: 'console',
        icon: 'server',
        disabled: true,
      },
    ]);
  });

  it('round-trips a machine through its run location value', () => {
    expect(machineIdOf(machineRunLocation('vm'))).toBe('vm');
    expect(machineIdOf('local')).toBeNull();
    expect(machineIdOf('devbox')).toBeNull();
  });

  it('turns this computer or an SSH host into its machine once it is one', () => {
    expect(machineFor('local', MACHINES)?.id).toBe('laptop');
    expect(machineFor('devbox', MACHINES)?.id).toBe('box');
    expect(machineFor('other-host', MACHINES)).toBeNull();
    expect(machineFor('machine:vm', MACHINES)?.id).toBe('vm');
    expect(machineFor('machine:gone', MACHINES)).toBeNull();
  });

  it('says whether this computer and an SSH host are machines yet', () => {
    expect(thisComputerIsMachine(MACHINES)).toBe(true);
    expect(thisComputerIsMachine([MACHINES[0]])).toBe(false);
    expect(sshHostIsMachine(MACHINES, 'devbox')).toBe(true);
    expect(sshHostIsMachine(MACHINES, 'other-host')).toBe(false);
  });
});

describe('reconciling the run location', () => {
  it('keeps Switch cloud', () => {
    expect(reconciledRunLocation('cloud', MACHINES)).toBeNull();
  });

  it('picks this computer or an SSH host as its machine once it is one', () => {
    expect(reconciledRunLocation('local', MACHINES)).toBe('machine:laptop');
    expect(reconciledRunLocation('devbox', MACHINES)).toBe('machine:box');
    expect(reconciledRunLocation('other-host', MACHINES)).toBeNull();
    expect(reconciledRunLocation('local', null)).toBeNull();
  });

  it('falls back to this computer when the chosen machine is not listed', () => {
    expect(reconciledRunLocation(machineRunLocation('vm'), MACHINES)).toBeNull();
    expect(reconciledRunLocation(machineRunLocation('gone'), MACHINES)).toBe('local');
    expect(reconciledRunLocation(machineRunLocation('vm'), null)).toBe('local');
  });
});

describe('the Switch cloud machine', () => {
  const cloud = machine({ id: 'cloud', name: 'switch-cloud', kind: 'ec2' });

  it('is the owner’s ec2 controller, which Switch cloud then places agents on', () => {
    expect(switchCloudMachine([...MACHINES, cloud])?.id).toBe('cloud');
  });

  it('is none without an ec2 controller, so Switch cloud stays a hosted launch', () => {
    expect(switchCloudMachine(MACHINES)).toBeNull();
    expect(switchCloudMachine([])).toBeNull();
    expect(switchCloudMachine(null)).toBeNull();
    expect(switchCloudMachine([machine({ id: 'old', kind: 'ec2', state: 'revoked' })])).toBeNull();
  });

  it('is offered as Switch cloud, not as one of the listed machines', () => {
    expect(machineRunLocations([...MACHINES, cloud]).map((option) => option.value)).toEqual(
      machineRunLocations(MACHINES).map((option) => option.value)
    );
  });
});

describe('adding a Switch cloud agent', () => {
  it('ensures the cloud machine first, then places the agent on its controller', async () => {
    const calls: string[] = [];
    const ensure = vi.fn(async () => {
      calls.push('ensure');
      return { controller_id: 'controller-1' };
    });
    const add = vi.fn(async (machineId: string) => {
      calls.push(`add:${machineId}`);
      return 'agent';
    });
    await expect(addSwitchCloudAgent(null, ensure, add)).resolves.toBe('agent');
    expect(calls).toEqual(['ensure', 'add:controller-1']);
  });

  it('places the agent on the existing cloud machine without ensuring one', async () => {
    const ensure = vi.fn(async () => ({ controller_id: 'other' }));
    const add = vi.fn(async (machineId: string) => machineId);
    const cloud = machine({ id: 'cloud', kind: 'ec2' });
    await expect(addSwitchCloudAgent(cloud, ensure, add)).resolves.toBe('cloud');
    expect(ensure).not.toHaveBeenCalled();
  });

  it('fails loud when the ensured machine runs no controller', async () => {
    const add = vi.fn(async (machineId: string) => machineId);
    await expect(
      addSwitchCloudAgent(null, async () => ({ controller_id: null }), add)
    ).rejects.toThrow(/does not run the agent controller/);
    expect(add).not.toHaveBeenCalled();
  });
});
