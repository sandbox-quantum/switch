import { describe, expect, it } from 'vitest';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  boxBackends,
  machineFor,
  machineIdOf,
  machineRunLocation,
  hasSharedCloudBox,
  sharedCloudBoxIds,
  machineRunLocations,
  offlineSharedCloudMachine,
  sharedCloudMachine,
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
    os: null,
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

  it('lists the Switch cloud machine only while it is online, as the cloud', () => {
    const cloud = machine({ id: 'ec2', name: 'Switch cloud', kind: 'ec2', cloud: true });
    expect(machineRunLocations([cloud])).toEqual([
      {
        value: 'machine:ec2',
        label: 'Switch cloud',
        tag: 'cloud',
        icon: 'cloud',
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

describe("a shared-cloud user's box", () => {
  // Whatever system it runs (gVisor or not), only Core's backend makes a machine a box.
  const box = machine({ id: 'pod', name: 'Test user A' });
  const laptop = machine({ id: 'laptop', kind: 'console', local: { kind: 'this-computer' } });
  const second = machine({ id: 'second-laptop', os: 'macos' });
  // What Core reports for each enrolled cloud machine: only `pod` is a box.
  const core = boxBackends([{ controller_id: 'pod', backend: 'box' }]);
  const none = boxBackends([]);

  it("is recognised only by Core's backend, never by a guess (switch plan)", () => {
    expect(hasSharedCloudBox([box], true, core)).toBe(true);
    expect(hasSharedCloudBox([second], true, core)).toBe(false);
    // No backend from Core (an older Core, or someone's own controller under gVisor): not a box.
    expect(hasSharedCloudBox([box], true, none)).toBe(false);
    // Core says it's a v1 VM: never a box, whatever its kernel.
    expect(
      hasSharedCloudBox([box], true, boxBackends([{ controller_id: 'pod', backend: 'vm' }]))
    ).toBe(false);
    // A local machine is never a box, even if a backend were claimed for it.
    expect(
      hasSharedCloudBox([laptop], true, boxBackends([{ controller_id: 'laptop', backend: 'box' }]))
    ).toBe(false);
    // Registered as a hosted machine for the idle stop, its controller is kind `ec2` (cloud), still the box.
    const hosted = { ...box, kind: 'ec2', cloud: true };
    expect(hasSharedCloudBox([hosted], true, core)).toBe(true);
    expect(sharedCloudMachine([hosted], new Set([hosted.id]), core)).toBe(hosted);
    expect([...sharedCloudBoxIds([box, second, laptop], true, core)]).toEqual([box.id]);
    expect(sharedCloudBoxIds(undefined, true, core).size).toBe(0);
  });

  it('is never a box without hosted_v2: everything reads as upstream (states, Run location, buddy copy)', () => {
    const hosted = { ...box, kind: 'ec2', cloud: true };
    expect(hasSharedCloudBox([box, hosted, laptop], false, core)).toBe(false);
    expect(sharedCloudBoxIds([box, hosted], false, core).size).toBe(0);
  });

  it('leaves out machines with no controller yet, or no backend', () => {
    expect(
      boxBackends([{ controller_id: null, backend: 'box' }, { controller_id: 'pod' }]).size
    ).toBe(0);
  });

  it("is first where the user's agents already run, whatever its system reports", () => {
    const plain = machine({ id: 'plain-box' });
    expect(sharedCloudMachine([laptop, plain, second], new Set(['plain-box']), none)?.id).toBe(
      'plain-box'
    );
    expect(
      sharedCloudMachine([laptop, box, second], new Set(['pod', 'second-laptop']), core)
    ).toBeNull();
    expect(
      sharedCloudMachine([laptop, { ...box, state: 'offline' }], new Set(['pod']), core)
    ).toBeNull();
    expect(sharedCloudMachine([laptop], new Set(['laptop']), core)).toBeNull();
  });

  it('falls back to the one machine Core says is a box only for someone with no agents yet', () => {
    expect(sharedCloudMachine([laptop, box, second], new Set(), core)?.id).toBe('pod');
    const two = boxBackends([
      { controller_id: 'pod', backend: 'box' },
      { controller_id: 'pod-2', backend: 'box' },
    ]);
    expect(sharedCloudMachine([box, { ...box, id: 'pod-2' }], new Set(), two)).toBeNull();
    expect(sharedCloudMachine([laptop, second], new Set(), core)).toBeNull();
    // With no backend from Core, there is no fallback.
    expect(sharedCloudMachine([laptop, box, second], new Set(), none)).toBeNull();
  });

  it('is listed as Switch cloud, with the cloud tag and icon', () => {
    const option = machineRunLocations([laptop, box], 'pod').find((o) => o.value === 'machine:pod');
    expect(option).toMatchObject({ label: 'Switch cloud', tag: 'cloud', icon: 'cloud' });
  });
  it('U17-b: picks the box, never an online laptop with no agents', () => {
    const otherLaptop = machine({ id: 'other-laptop', kind: 'console', os: 'macos' });
    expect(sharedCloudMachine([box, otherLaptop], new Set(['pod']), core)?.id).toBe('pod');
  });

  it('U17-f: names the box as offline, and picks nothing else', () => {
    const offline = { ...box, state: 'offline' as const };
    expect(sharedCloudMachine([offline, second], new Set(['pod']), core)).toBeNull();
    expect(offlineSharedCloudMachine([offline, second], new Set(['pod']), core)?.id).toBe('pod');
    expect(offlineSharedCloudMachine([box, second], new Set(['pod']), core)).toBeNull();
  });

  it('U17-g: an older server that sends no system version still uses where agents run', () => {
    const noVersion = machine({ id: 'old-box' });
    expect(sharedCloudMachine([laptop, noVersion], new Set(['old-box']), none)?.id).toBe('old-box');
    expect(sharedCloudMachine([laptop, noVersion], new Set(), none)).toBeNull();
  });
});
