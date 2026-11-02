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

/** Each enrolled cloud machine's backend as Core reports it (`vm` or `box`), by its controller id. */
export type BoxBackends = ReadonlyMap<string, 'vm' | 'box'>;

/**
 * The backends Core reports for the owner's cloud machines, keyed by the
 * controller each enrolled as. Core sends `backend` only with hosted agents
 * v2 on; a machine with none, or not enrolled yet, is left out, and so is
 * never a box.
 */
export function boxBackends(
  cloudMachines:
    | readonly { controller_id: string | null; backend?: 'vm' | 'box' }[]
    | null
    | undefined
): BoxBackends {
  const backends = new Map<string, 'vm' | 'box'>();
  for (const machine of cloudMachines ?? []) {
    if (machine.controller_id && machine.backend)
      backends.set(machine.controller_id, machine.backend);
  }
  return backends;
}

/**
 * Whether a machine is a box on the shared cloud: only when Core says so, by
 * its cloud machine's `backend` (switch plan: Core's answer, never a guess).
 * A machine Core says nothing about is not a box, whatever it runs on.
 */
function isSharedCloudBox(machine: OwnedMachine, backends: BoxBackends): boolean {
  return machine.local == null && backends.get(machine.id) === 'box';
}

/**
 * The ids of the shared-cloud boxes among the owner's machines; empty while
 * they aren't known, and always empty unless the server runs hosted agents
 * v2 (`hosted_v2`, passed as `offered`).
 */
export function sharedCloudBoxIds(
  machines: OwnedMachine[] | null | undefined,
  offered: boolean,
  backends: BoxBackends
): Set<string> {
  if (!offered) return new Set();
  return new Set(
    (machines ?? [])
      .filter((machine) => isSharedCloudBox(machine, backends))
      .map((machine) => machine.id)
  );
}

/** Whether the owner has a shared-cloud box, on a server running hosted agents v2. */
export function hasSharedCloudBox(
  machines: OwnedMachine[] | null | undefined,
  offered: boolean,
  backends: BoxBackends
): boolean {
  return sharedCloudBoxIds(machines, offered, backends).size > 0;
}

/**
 * Where a shared-cloud user's new agent goes, by two signals in turn:
 *
 * 1. the one machine their agents already run on, when they have agents;
 * 2. for someone with no agents yet, their one machine Core says is a box.
 *
 * Either way the machine must be online and be neither this computer, an SSH
 * host nor a v2 cloud machine. Null otherwise, so the form asks rather than
 * guesses: their agents spread over several machines, the box offline, or
 * more than one box.
 */
export function sharedCloudMachine(
  machines: OwnedMachine[],
  /** The machines the user's agents are placed on. */
  agentMachineIds: ReadonlySet<string>,
  backends: BoxBackends
): OwnedMachine | null {
  const eligible = (machine: OwnedMachine | undefined) =>
    !!machine &&
    machine.local == null &&
    (!machine.cloud || isSharedCloudBox(machine, backends)) &&
    machine.state === 'online';
  if (agentMachineIds.size > 0) {
    if (agentMachineIds.size !== 1) return null;
    const [id] = agentMachineIds;
    const machine = machines.find((candidate) => candidate.id === id);
    return eligible(machine) ? machine! : null;
  }
  const boxes = machines.filter((machine) => isSharedCloudBox(machine, backends));
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
  agentMachineIds: ReadonlySet<string>,
  backends: BoxBackends
): OwnedMachine | null {
  if (agentMachineIds.size !== 1) return null;
  const [id] = agentMachineIds;
  const machine = machines.find((candidate) => candidate.id === id);
  if (
    !machine ||
    machine.local != null ||
    (machine.cloud && !isSharedCloudBox(machine, backends)) ||
    machine.state === 'online'
  )
    return null;
  return machine;
}
