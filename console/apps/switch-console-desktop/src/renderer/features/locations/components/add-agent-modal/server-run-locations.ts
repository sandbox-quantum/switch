import type { OwnedMachine } from '@shared/core/managed-agents/managed-agents';

const MACHINE_PREFIX = 'machine:';

/** The run location value for one of the server's machines. */
export function machineRunLocation(machineId: string): string {
  return `${MACHINE_PREFIX}${machineId}`;
}

/** The machine id a run location value names, or null when it names no server machine. */
export function machineIdOf(runLocation: string): string | null {
  return runLocation.startsWith(MACHINE_PREFIX) ? runLocation.slice(MACHINE_PREFIX.length) : null;
}

/** One entry in the Run location list. */
export type RunLocationOption = {
  value: string;
  label: string;
  /** The right-hand tag: what sort of machine it is. */
  tag: string;
  icon: 'monitor' | 'server' | 'cloud';
  disabled: boolean;
};

/**
 * The server's machines as Run location entries. Offline machines are listed,
 * but cannot be picked; but the owner's Switch cloud machine, which the Switch
 * cloud entry starts, is listed only while it is online.
 */
export function machineRunLocations(
  machines: OwnedMachine[],
  /** The user's box on the shared cloud, named as prod names a cloud machine. */
  sharedCloudId: string | null = null
): RunLocationOption[] {
  return machines
    .filter((machine) => !machine.cloud || machine.state === 'online')
    .sort(
      (a, b) =>
        Number(b.local?.kind === 'this-computer') - Number(a.local?.kind === 'this-computer')
    )
    .map((machine) => {
      const offline = machine.state !== 'online';
      if (machine.id === sharedCloudId)
        return {
          value: machineRunLocation(machine.id),
          label: SHARED_CLOUD_LABEL,
          tag: 'cloud',
          icon: 'cloud' as const,
          disabled: offline,
        };
      const name = machineLabel(machine);
      return {
        value: machineRunLocation(machine.id),
        label: offline ? `${name} (offline)` : name,
        tag:
          machine.local?.kind === 'this-computer'
            ? 'this Console'
            : machine.local?.kind === 'ssh-host'
              ? 'ssh'
              : machine.cloud
                ? 'cloud'
                : machine.kind,
        icon:
          machine.local?.kind === 'this-computer' ? 'monitor' : machine.cloud ? 'cloud' : 'server',
        disabled: offline,
      };
    });
}

/**
 * What a machine is called here: "This computer" for the one this Console runs
 * on, rather than its host name; otherwise the name it has on the server.
 */
export function machineLabel(machine: OwnedMachine): string {
  return machine.local?.kind === 'this-computer' ? 'This computer' : machine.name;
}

/** Whether this computer is one of the server's machines. */
export function thisComputerIsMachine(machines: OwnedMachine[]): boolean {
  return machines.some((machine) => machine.local?.kind === 'this-computer');
}

/** Whether an SSH host is one of the server's machines. */
export function sshHostIsMachine(machines: OwnedMachine[], sshHost: string): boolean {
  return machines.some(
    (machine) => machine.local?.kind === 'ssh-host' && machine.local.sshHost === sshHost
  );
}

/**
 * The server machine a run location turned into: this computer (`local`) or an
 * SSH host once it is a machine on the server. Null when it is not one.
 */
export function machineFor(runLocation: string, machines: OwnedMachine[]): OwnedMachine | null {
  const id = machineIdOf(runLocation);
  if (id !== null) return machines.find((machine) => machine.id === id) ?? null;
  return (
    machines.find((machine) =>
      runLocation === 'local'
        ? machine.local?.kind === 'this-computer'
        : machine.local?.kind === 'ssh-host' && machine.local.sshHost === runLocation
    ) ?? null
  );
}

/** What a shared-cloud user's box is called here: prod's name for a cloud machine. */
export const SHARED_CLOUD_LABEL = 'Switch cloud';

/**
 * Whether a machine is a box on the shared cloud. Boxes run under gVisor, and
 * their controller reports gVisor's kernel as its system version
 * (`4.19.0-gvisor`), which no laptop or server does. It is what the server
 * already says about every machine, so recognising a box needs no change to
 * Core. A proper machine kind replaces this at Level 3.
 */
function isSharedCloudBox(machine: OwnedMachine): boolean {
  // Not `!cloud`: a box registered as a hosted machine for the idle stop has
  // its controller re-kinded `ec2`, as Core does for any cloud enrolment, and
  // is still the person's box. gVisor's kernel is what tells a box apart.
  return machine.local == null && (machine.osVersion ?? '').toLowerCase().includes('gvisor');
}

/**
 * The ids of the shared-cloud boxes among the owner's machines; empty while
 * they aren't known, and always empty unless the server offers hosted agents
 * (`hosted_agents`). The gVisor kernel alone is only a hint: someone running
 * their own controller under gVisor must never get the shared-cloud screens.
 */
export function sharedCloudBoxIds(
  machines: OwnedMachine[] | null | undefined,
  offered: boolean
): Set<string> {
  if (!offered) return new Set();
  return new Set((machines ?? []).filter(isSharedCloudBox).map((machine) => machine.id));
}

/** Whether the owner has a shared-cloud box, on a server offering hosted agents. */
export function hasSharedCloudBox(
  machines: OwnedMachine[] | null | undefined,
  offered: boolean
): boolean {
  return sharedCloudBoxIds(machines, offered).size > 0;
}

/**
 * Where a shared-cloud user's new agent goes, by two signals in turn:
 *
 * 1. the one machine their agents already run on, when they have agents;
 * 2. for someone with no agents yet, their one machine reporting gVisor.
 *
 * Either way the machine must be online and be neither this computer, an SSH
 * host nor a v2 cloud machine. Null otherwise, so the form asks rather than
 * guesses: their agents spread over several machines, the box offline, or
 * more than one gVisor machine. The gVisor string is only a hint, so it
 * never overrides where the user's agents actually run.
 */
export function sharedCloudMachine(
  machines: OwnedMachine[],
  /** The machines the user's agents are placed on. */
  agentMachineIds: ReadonlySet<string>
): OwnedMachine | null {
  const eligible = (machine: OwnedMachine | undefined) =>
    !!machine &&
    machine.local == null &&
    (!machine.cloud || isSharedCloudBox(machine)) &&
    machine.state === 'online';
  if (agentMachineIds.size > 0) {
    if (agentMachineIds.size !== 1) return null;
    const [id] = agentMachineIds;
    const machine = machines.find((candidate) => candidate.id === id);
    return eligible(machine) ? machine! : null;
  }
  const boxes = machines.filter((machine) => isSharedCloudBox(machine));
  return boxes.length === 1 && eligible(boxes[0]) ? boxes[0]! : null;
}

/**
 * The user's box when it is known but offline: the one machine their agents
 * run on is there and would be picked, but isn't online. The form then says
 * the box is offline rather than asking in general, and never falls back to
 * another machine. Null otherwise.
 */
export function offlineSharedCloudMachine(
  machines: OwnedMachine[],
  agentMachineIds: ReadonlySet<string>
): OwnedMachine | null {
  if (agentMachineIds.size !== 1) return null;
  const [id] = agentMachineIds;
  const machine = machines.find((candidate) => candidate.id === id);
  if (
    !machine ||
    machine.local != null ||
    (machine.cloud && !isSharedCloudBox(machine)) ||
    machine.state === 'online'
  )
    return null;
  return machine;
}
