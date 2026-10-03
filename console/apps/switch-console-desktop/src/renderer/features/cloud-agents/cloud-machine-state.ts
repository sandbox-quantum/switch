import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';

/** Below this share of the disk free, the machine card warns that space is low. */
export const LOW_DISK_FRACTION = 0.1;

export type MachineAction = 'stop' | 'start' | 'retry';

export type MachineDisk = {
  usedPercent: number;
  availableBytes: number;
  totalBytes: number;
  low: boolean;
};

export type MachinePresentation = {
  label: string;
  problem: string | null;
  retainUntil: string | null;
  disk: MachineDisk | null;
  actions: MachineAction[];
};

function isRetained(machine: CloudMachine): boolean {
  return (
    machine.desired_state === 'retained' ||
    (machine.state === 'retained' && machine.desired_state !== 'running')
  );
}

function isBeingDeleted(machine: CloudMachine, now: number): boolean {
  if (machine.state === 'error' && machine.error_code === 'machine_needs_attention') return false;
  return (
    machine.state === 'deleting' ||
    machine.desired_state === 'deleted' ||
    (isRetained(machine) &&
      machine.retain_until !== null &&
      Date.parse(machine.retain_until) <= now)
  );
}

function machineLabel(machine: CloudMachine, now: number): string {
  if (isBeingDeleted(machine, now)) return 'Deleting disk…';
  if (machine.state === 'error') return 'Error';
  if (isRetained(machine)) return 'Retained';
  if (machine.sleeping) return 'Sleeping';
  if (machine.desired_state === 'stopped')
    return machine.state === 'stopped' ? 'Stopped' : 'Stopping…';
  if (machine.state === 'ready') return 'Ready';
  return 'Provisioning';
}

function machineProblem(machine: CloudMachine, now: number): string | null {
  if (isBeingDeleted(machine, now)) return null;
  if (machine.error_code === 'disk_full') return 'The machine’s disk is full.';
  if (machine.state !== 'error') return null;
  if (machine.error_code === 'machine_needs_attention')
    return 'The machine needs attention. Contact your server administrator.';
  if (machine.error_code === 'machine_connect_timeout')
    return 'The machine did not connect in time. Retry, and if it fails again contact your server administrator.';
  return machine.error ?? 'The machine could not start.';
}

function machineDisk(machine: CloudMachine): MachineDisk | null {
  if (!machine.disk || machine.disk.total_bytes === 0) return null;
  const { total_bytes: totalBytes, available_bytes: availableBytes } = machine.disk;
  return {
    usedPercent: Math.round(((totalBytes - availableBytes) / totalBytes) * 100),
    availableBytes,
    totalBytes,
    low: availableBytes < totalBytes * LOW_DISK_FRACTION,
  };
}

function machineActions(machine: CloudMachine, now: number): MachineAction[] {
  if (isBeingDeleted(machine, now)) return [];
  if (machine.state === 'error')
    return machine.error_code === 'machine_needs_attention' ? [] : ['retry'];
  if (
    isRetained(machine) ||
    machine.state === 'retained' ||
    machine.state === 'deleting' ||
    machine.state === 'deleted' ||
    machine.desired_state === 'deleted'
  )
    return [];
  const actions: MachineAction[] = [];
  if (machine.desired_state === 'running' || machine.sleeping) actions.push('stop');
  if (machine.desired_state === 'stopped') actions.push('start');
  return actions;
}

/** What the machine card shows for a machine: its state, trouble, disk and actions. */
export function machinePresentation(machine: CloudMachine, now: number): MachinePresentation {
  return {
    label: machineLabel(machine, now),
    problem: machineProblem(machine, now),
    retainUntil:
      isRetained(machine) &&
      !isBeingDeleted(machine, now) &&
      machine.state !== 'error' &&
      machine.retain_until !== null &&
      Date.parse(machine.retain_until) > now
        ? machine.retain_until
        : null,
    disk: machineDisk(machine),
    actions: machineActions(machine, now),
  };
}
