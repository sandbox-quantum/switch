import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  isCloudRunLocation,
  machineFor,
  machineIdOf,
  machineRunLocation,
  machineRunLocations,
  reconciledRunLocation,
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

describe('the run locations a Switch Cloud server offers', () => {
  it('runs in Switch cloud unless one of the owner machines is chosen', () => {
    expect(isCloudRunLocation('cloud', true)).toBe(true);
    expect(isCloudRunLocation('local', true)).toBe(true);
    expect(isCloudRunLocation(machineRunLocation('vm'), true)).toBe(false);
  });

  it('runs in Switch cloud elsewhere only when it is chosen', () => {
    expect(isCloudRunLocation('cloud', false)).toBe(true);
    expect(isCloudRunLocation('local', false)).toBe(false);
    expect(isCloudRunLocation('devbox', false)).toBe(false);
    expect(isCloudRunLocation(machineRunLocation('vm'), false)).toBe(false);
  });

  it('keeps Switch cloud rather than turning this computer into its machine', () => {
    expect(reconciledRunLocation('cloud', MACHINES, true)).toBeNull();
    expect(reconciledRunLocation('local', MACHINES, true)).toBeNull();
  });

  it('keeps a listed machine, and falls back to Switch cloud when it goes away', () => {
    expect(reconciledRunLocation(machineRunLocation('vm'), MACHINES, true)).toBeNull();
    expect(reconciledRunLocation(machineRunLocation('gone'), MACHINES, true)).toBe('cloud');
    expect(reconciledRunLocation(machineRunLocation('vm'), null, true)).toBe('cloud');
  });
});

describe('reconciling the run location off Switch Cloud', () => {
  it('picks this computer or an SSH host as its machine once it is one', () => {
    expect(reconciledRunLocation('local', MACHINES, false)).toBe('machine:laptop');
    expect(reconciledRunLocation('devbox', MACHINES, false)).toBe('machine:box');
    expect(reconciledRunLocation('other-host', MACHINES, false)).toBeNull();
    expect(reconciledRunLocation('local', null, false)).toBeNull();
  });

  it('falls back to this computer when the chosen machine is not listed', () => {
    expect(reconciledRunLocation(machineRunLocation('vm'), MACHINES, false)).toBeNull();
    expect(reconciledRunLocation(machineRunLocation('gone'), MACHINES, false)).toBe('local');
    expect(reconciledRunLocation(machineRunLocation('vm'), null, false)).toBe('local');
  });
});
