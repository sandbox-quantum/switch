import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  machineFor,
  machineIdOf,
  machineRunLocation,
  machineRunLocations,
  sshHostIsMachine,
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
    acceptsLogins: false,
    cloud: false,
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

  it('lists the Switch cloud machine only while it is online, tagged as the cloud', () => {
    const cloud = machine({ id: 'ec2', name: 'Switch cloud', kind: 'ec2', cloud: true });
    expect(machineRunLocations([cloud])).toEqual([
      {
        value: 'machine:ec2',
        label: 'Switch cloud',
        tag: 'cloud',
        icon: 'server',
        disabled: false,
      },
    ]);
    expect(machineRunLocations([{ ...cloud, state: 'offline' }])).toEqual([]);
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
