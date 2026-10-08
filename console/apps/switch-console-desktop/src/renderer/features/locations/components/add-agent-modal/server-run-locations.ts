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

/** The server's machines as Run location entries. Offline machines are listed, but cannot be picked. */
export function machineRunLocations(machines: OwnedMachine[]): RunLocationOption[] {
  return [...machines]
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
