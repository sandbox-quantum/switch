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
  icon: 'monitor' | 'server';
  disabled: boolean;
};

/** The controller kind of an owner's Switch cloud machine. */
const CLOUD_MACHINE_KIND = 'ec2';

/**
 * The owner's Switch cloud machine: their `ec2` controller, which "Switch
 * cloud" places a new agent on as a managed agent. Null when they have none
 * yet, and "Switch cloud" ensures their cloud machine first.
 */
export function switchCloudMachine(machines: OwnedMachine[] | null): OwnedMachine | null {
  return (
    machines?.find(
      (machine) => machine.kind === CLOUD_MACHINE_KIND && machine.state !== 'revoked'
    ) ?? null
  );
}

/**
 * The server's machines as Run location entries. Offline machines are listed,
 * but cannot be picked. A Switch cloud machine is not among them: it is the
 * "Switch cloud" entry.
 */
export function machineRunLocations(machines: OwnedMachine[]): RunLocationOption[] {
  return machines
    .filter((machine) => machine.kind !== CLOUD_MACHINE_KIND)
    .sort(
      (a, b) =>
        Number(b.local?.kind === 'this-computer') - Number(a.local?.kind === 'this-computer')
    )
    .map((machine) => {
      const offline = machine.state !== 'online';
      const name = machineLabel(machine);
      return {
        value: machineRunLocation(machine.id),
        label: offline ? `${name} (offline)` : name,
        tag:
          machine.local?.kind === 'this-computer'
            ? 'this Console'
            : machine.local?.kind === 'ssh-host'
              ? 'ssh'
              : machine.kind,
        icon: machine.local?.kind === 'this-computer' ? 'monitor' : 'server',
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

/**
 * The run location to move to once the server's machines are known, or null to
 * stay. A machine the server no longer lists falls back to this computer;
 * this computer or an SSH host that is a machine is picked as it.
 */
export function reconciledRunLocation(
  runLocation: string,
  machines: OwnedMachine[] | null
): string | null {
  if (runLocation === 'cloud') return null;
  const id = machineIdOf(runLocation);
  if (id !== null) {
    if (machines?.some((machine) => machine.id === id)) return null;
    return 'local';
  }
  if (!machines) return null;
  const enrolled = machineFor(runLocation, machines);
  return enrolled ? machineRunLocation(enrolled.id) : null;
}

/**
 * Create a "Switch cloud" agent as a managed agent on the owner's ec2
 * controller. With no Switch cloud machine yet, it ensures their cloud machine
 * first, which links the controller the agent is placed on.
 */
export async function addSwitchCloudAgent<T>(
  cloudMachine: OwnedMachine | null,
  ensureCloudMachine: () => Promise<{ controller_id: string | null }>,
  addManagedAgent: (machineId: string) => Promise<T>
): Promise<T> {
  if (cloudMachine) return addManagedAgent(cloudMachine.id);
  const ensured = await ensureCloudMachine();
  if (!ensured.controller_id)
    throw new Error(
      'Your Switch cloud machine does not run the agent controller, so the agent cannot be placed on it.'
    );
  return addManagedAgent(ensured.controller_id);
}
