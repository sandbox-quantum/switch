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

/**
 * How long a v2 box may take before the card says it is taking longer than
 * usual: the requirement's p90s for a first start and a wake.
 */
export const FIRST_START_SLOW_MS = 30_000;
export const WAKE_SLOW_MS = 20_000;

export const STARTING_TITLE = 'Starting your agent…';
export const WAKING_TITLE = 'Waking your agent…';
export const SLOW_TITLE = 'Still starting…';
export const FAILED_TITLE = 'Couldn’t start your agent';
export const PENDING_HELPER = 'Your agent will appear here when it’s ready.';
export const SLOW_HELPER =
  'This is taking longer than usual. You can leave this page; we’ll keep going.';

/**
 * A v2 box's start-up, as the card's status area shows it: on its way up
 * (`slowAt` is when it turns "taking longer", null when Core gave no start
 * time and so no hint is shown), or failed, with Core's own reason.
 */
export type BoxStatus =
  | { kind: 'starting'; title: string; helper: string; slowAt: number | null }
  | { kind: 'failed'; title: string; helper: string };

export type MachinePresentation = {
  label: string;
  problem: string | null;
  retainUntil: string | null;
  disk: MachineDisk | null;
  actions: MachineAction[];
  boxStatus: BoxStatus | null;
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

/**
 * Asleep, as the machine card would say: a sleeping machine that is also being
 * deleted, in error or retained is shown as that instead.
 */
export function isMachineAsleep(machine: CloudMachine, now: number): boolean {
  return (
    machine.sleeping &&
    !isAdminStopped(machine) &&
    !isBeingDeleted(machine, now) &&
    machine.state !== 'error' &&
    !isRetained(machine)
  );
}

/** A server administrator holds the machine stopped; only they can release it. */
function isAdminStopped(machine: CloudMachine): boolean {
  return machine.stopped_by_admin;
}

function machineLabel(machine: CloudMachine, now: number): string {
  if (isAdminStopped(machine)) return 'Stopped by an administrator';
  if (isBeingDeleted(machine, now)) return 'Deleting disk…';
  if (machine.state === 'error') return 'Error';
  if (isRetained(machine)) return 'Retained';
  if (isMachineAsleep(machine, now)) return 'Sleeping';
  if (machine.desired_state === 'stopped')
    return machine.state === 'stopped' ? 'Stopped' : 'Stopping…';
  if (machine.state === 'ready') return 'Ready';
  return 'Provisioning';
}

function machineProblem(machine: CloudMachine, now: number): string | null {
  if (isAdminStopped(machine))
    return 'A server administrator stopped the machine. Contact them to have it released.';
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
  if (isAdminStopped(machine)) return [];
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

/**
 * The status area for a v2 box, from Core's `start` and state alone; null for
 * a v1 machine, a server with hosted agents v2 off (no `backend`), and a box
 * neither starting nor failed, which keep the card's usual label.
 *
 * Core cannot tell a box waiting for a new machine from one starting where
 * there is room, so there is no separate slow-path state: "taking longer"
 * comes from how long ago Core was asked (`since`), never from when the page
 * opened.
 */
function boxStatus(machine: CloudMachine, now: number): BoxStatus | null {
  if (machine.backend !== 'box') return null;
  if (isAdminStopped(machine) || isBeingDeleted(machine, now)) return null;
  if (machine.state === 'error') {
    return {
      kind: 'failed',
      title: FAILED_TITLE,
      helper: machineProblem(machine, now) ?? 'The machine could not start.',
    };
  }
  const start = machine.start;
  if (!start) return null;
  const threshold = start.kind === 'wake' ? WAKE_SLOW_MS : FIRST_START_SLOW_MS;
  const since = start.since === null ? Number.NaN : Date.parse(start.since);
  const slowAt = Number.isNaN(since) ? null : since + threshold;
  if (slowAt !== null && now >= slowAt) {
    return { kind: 'starting', title: SLOW_TITLE, helper: SLOW_HELPER, slowAt };
  }
  return {
    kind: 'starting',
    title: start.kind === 'wake' ? WAKING_TITLE : STARTING_TITLE,
    helper: PENDING_HELPER,
    slowAt,
  };
}

/** What the machine card shows for a machine: its state, trouble, disk and actions. */
export function machinePresentation(machine: CloudMachine, now: number): MachinePresentation {
  return {
    boxStatus: boxStatus(machine, now),
    label: machineLabel(machine, now),
    problem: machineProblem(machine, now),
    retainUntil:
      isRetained(machine) &&
      !isAdminStopped(machine) &&
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
