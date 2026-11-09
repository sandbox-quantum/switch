import { describe, expect, it } from 'vitest';
import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';
import {
  autoEnablesMachine,
  boxBackends,
  boxWakeState,
  holdsThisComputer,
  machineFor,
  machineIdOf,
  machineRunIcon,
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

// Add agent on hosted agents v2: nothing turned on by itself, and a put-away box started.
describe('the icon on a picked machine run location', () => {
  it("with no shared box and no machine in the list, shows upstream's server icon, not cloud", () => {
    expect(machineRunIcon(null, null)).toBe('server');
  });
  it('with no shared box, shows cloud only for the Switch cloud machine, as upstream', () => {
    expect(machineRunIcon(machine({ id: 'c', cloud: true }), null)).toBe('cloud');
    expect(machineRunIcon(machine({ id: 'vm' }), null)).toBe('server');
  });
  it('shows this computer as a monitor', () => {
    expect(machineRunIcon(MACHINES[2], null)).toBe('this-computer');
    expect(machineRunIcon(MACHINES[2], 'laptop')).toBe('this-computer');
  });
  it('shows the picked shared box as cloud, and only that one', () => {
    expect(machineRunIcon(machine({ id: 'b1' }), 'b1')).toBe('cloud');
    expect(machineRunIcon(machine({ id: 'b2' }), 'b1')).toBe('server');
    expect(machineRunIcon(null, 'b1')).toBe('server');
  });
});

describe('autoEnablesMachine', () => {
  it('never with hosted_v2 on (B38: only the button adds this computer)', () => {
    expect(autoEnablesMachine(true, true)).toBe(false);
  });
  it('as upstream once the flags answer with v2 off', () => {
    expect(autoEnablesMachine(true, false)).toBe(true);
  });
  it('not before the flags are read, nor after a failed read (every flag off)', () => {
    expect(autoEnablesMachine(false, false)).toBe(false);
  });
});

describe('boxWakeState', () => {
  const box = (patch: Partial<CloudMachine>): CloudMachine =>
    ({
      machine_id: 'm1',
      state: 'ready',
      desired_state: 'running',
      stop_reason: null,
      sleeping: false,
      revision: 1,
      instance_type: null,
      error: null,
      error_code: null,
      retain_until: null,
      heartbeat_at: null,
      disk: null,
      memory: null,
      agents: [],
      controller_id: 'c1',
      backend: 'box',
      ...patch,
    }) as CloudMachine;

  it('leaves a box its owner stopped to its card: ensure would not start it', () => {
    expect(
      boxWakeState([box({ state: 'stopped', desired_state: 'stopped', sleeping: false })], true)
        ?.action
    ).toBe('owner-stopped');
  });
  it('wakes a retained box whose state reads stopped (desired retained)', () => {
    expect(
      boxWakeState([box({ state: 'stopped', desired_state: 'retained', sleeping: false })], true)
        ?.action
    ).toBe('wake');
  });
  it('wakes a box put away (retained) or asleep (stopped)', () => {
    expect(
      boxWakeState([box({ state: 'retained', desired_state: 'retained' })], true)?.action
    ).toBe('wake');
    expect(
      boxWakeState([box({ state: 'stopped', desired_state: 'stopped', sleeping: true })], true)
        ?.action
    ).toBe('wake');
  });
  it('waits for a box already starting', () => {
    expect(boxWakeState([box({ state: 'provisioning' })], true)?.action).toBe('starting');
    expect(boxWakeState([box({ state: 'queued' })], true)?.action).toBe('starting');
  });
  it('waits for a ready box whose controller is not online yet', () => {
    expect(boxWakeState([box({ state: 'ready' })], true, new Set())?.action).toBe('starting');
  });
  it('leaves a ready box, a box in error, a v1 machine, and everything with v2 off', () => {
    expect(boxWakeState([box({ state: 'ready' })], true, new Set(['c1']))).toBeNull();
    expect(boxWakeState([box({ state: 'error' })], true)).toBeNull();
    expect(boxWakeState([box({ state: 'retained', backend: 'vm' })], true)).toBeNull();
    expect(boxWakeState([box({ state: 'retained' })], false)).toBeNull();
  });
  it('asks nothing when there are two boxes', () => {
    expect(
      boxWakeState([box({ state: 'retained' }), box({ machine_id: 'm2', state: 'retained' })], true)
    ).toBeNull();
  });
});

describe('holdsThisComputer', () => {
  const wake = { machine: { machine_id: 'm1' }, action: 'wake' as const };
  const base = { v2: true, boxPicked: false, findingBox: false, boxWake: null, failedWakeId: null };
  it('holds while the box is found, woken or starting, on v2 only', () => {
    expect(holdsThisComputer({ ...base, findingBox: true })).toBe(true);
    expect(holdsThisComputer({ ...base, boxWake: wake })).toBe(true);
    expect(holdsThisComputer({ ...base, v2: false, findingBox: true, boxWake: wake })).toBe(false);
  });
  it('lets go once the box is picked', () => {
    expect(holdsThisComputer({ ...base, boxWake: wake, boxPicked: true })).toBe(false);
  });
  it('does not hold for a box its owner stopped', () => {
    expect(holdsThisComputer({ ...base, boxWake: { ...wake, action: 'owner-stopped' } })).toBe(
      false
    );
  });
  it('lets go when waking that box failed, so the form never waits for ever', () => {
    expect(holdsThisComputer({ ...base, boxWake: wake, failedWakeId: 'm1' })).toBe(false);
    expect(holdsThisComputer({ ...base, boxWake: wake, failedWakeId: 'other' })).toBe(true);
  });
});
