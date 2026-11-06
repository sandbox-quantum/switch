import type { CloudMachine } from '@shared/core/cloud-agents/cloud-agents';
import { FULL, NEARLY_FULL } from './your-cloud';

/** How full a capacity bar is: the same steps and words as Switch web. */
export type CapacityStep = 'ok' | 'nearly_full' | 'full';

export const CAPACITY_WORDS: Record<Exclude<CapacityStep, 'ok'>, string> = {
  nearly_full: 'Nearly full',
  full: 'Full right now',
};

/** One capacity line: "Memory: 3.1 GB of 8.0 GB", with its share and step. */
export type CapacityLine = {
  label: string;
  /** 0 to 100, one decimal. */
  usedPercent: number;
  step: CapacityStep;
};

export type HostedSummary = {
  /** "1 hosted agent", "3 hosted agents". */
  agents: string;
  /** "Agents awake: 3 of 12", or null when the box doesn't report it. */
  awake: CapacityLine | null;
  /** From `room`, which is memory (used of total), or null when not reported. */
  memory: CapacityLine | null;
  /** The 15 GB workspace disk, or null: shown as "Disk: not available". */
  disk: CapacityLine | null;
};

export const DISK_NOT_AVAILABLE = 'Disk: not available';

function step(share: number): CapacityStep {
  if (share >= FULL) return 'full';
  if (share > NEARLY_FULL) return 'nearly_full';
  return 'ok';
}

function percent(share: number): number {
  return Math.min(100, Math.round(share * 1000) / 10);
}

/** Bytes as gigabytes with one decimal, the way both apps print them. */
export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The box's disk, but only when the box says it measured the agents' 15 GB
 * workspace volume. Older boxes report the controller's own small volume in
 * the same field, which would be the wrong figure, so without the marker it's
 * "not available" rather than wrong.
 */
export function workspaceDisk(
  machine: Pick<CloudMachine, 'disk'>
): { total_bytes: number; available_bytes: number } | null {
  const disk = machine.disk;
  if (!disk || disk.scope !== 'workspace' || disk.total_bytes <= 0) return null;
  return disk;
}

/**
 * Your cloud in numbers, for Console's workspace page and Your Agents: how
 * many hosted agents, how many are awake out of the box's limit, memory, and
 * the workspace disk. Words and steps match Switch web.
 */
export function hostedSummary(
  machine: Pick<CloudMachine, 'agents' | 'awake' | 'room' | 'disk'>
): HostedSummary {
  const count = machine.agents.length;
  const { awake, room } = machine;
  const disk = workspaceDisk(machine);
  const awakeShare = awake && awake.max > 0 ? awake.running / awake.max : null;
  const memoryShare = room ? room.used_bytes / room.total_bytes : null;
  const diskUsed = disk ? disk.total_bytes - Math.min(disk.available_bytes, disk.total_bytes) : 0;
  const diskShare = disk ? diskUsed / disk.total_bytes : null;
  return {
    agents: `${count} hosted ${count === 1 ? 'agent' : 'agents'}`,
    awake:
      awake && awakeShare !== null
        ? {
            label: `Agents awake: ${awake.running} of ${awake.max}`,
            usedPercent: percent(awakeShare),
            step: step(awakeShare),
          }
        : null,
    memory:
      room && memoryShare !== null
        ? {
            label: `Memory: ${gb(room.used_bytes)} of ${gb(room.total_bytes)}`,
            usedPercent: percent(memoryShare),
            step: step(memoryShare),
          }
        : null,
    disk:
      disk && diskShare !== null
        ? {
            label: `Disk: ${gb(diskUsed)} of ${gb(disk.total_bytes)}`,
            usedPercent: percent(diskShare),
            step: step(diskShare),
          }
        : null,
  };
}
