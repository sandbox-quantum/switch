// Your cloud's capacity rows, the same steps and words as Switch Console
// (`features/cloud-agents/hosted-summary.ts`). Change both together.

import type { CloudMachine } from "../../../data/hostedCloud";
import { FULL, NEARLY_FULL } from "./yourCloud";

/** How full a capacity bar is: amber from 80%, red from 95%. */
export type CapacityStep = "ok" | "nearly_full" | "full";

type CapacityKind = "awake" | "memory" | "disk";

/** What to do when a bar is nearly full (from 80%) or full (from 95%): the PM's words, the same in Console. */
export const CAPACITY_ADVICE: Record<CapacityKind, Record<Exclude<CapacityStep, "ok">, string>> = {
  awake: {
    nearly_full: "Nearly full. Stop agents you're not using to free places.",
    full: "Full right now. New work waits until a place frees up.",
  },
  memory: {
    nearly_full: "Nearly full. Agents may slow down.",
    full: "Full right now. Stop an agent you don't need.",
  },
  disk: {
    nearly_full: "Nearly full. Ask your agents to delete files and build output you don't need.",
    full: "Full right now. Agents can't save more until space is freed.",
  },
};

/** One capacity line: "Memory: 3.1 GB of 8.0 GB", with its share, step and advice. */
export interface CapacityLine {
  label: string;
  /** 0 to 100, one decimal. */
  usedPercent: number;
  step: CapacityStep;
  /** The advice line for a nearly-full or full bar, or null below 80%. */
  advice: string | null;
}

export interface CapacityRows {
  /** "Agents awake: 3 of 12", or null when the box doesn't report it. */
  awake: CapacityLine | null;
  /** From `room`, which is memory (used of total), or null when not reported. */
  memory: CapacityLine | null;
  /** The workspace disk, or null: shown as "Disk: not available". */
  disk: CapacityLine | null;
}

export const DISK_NOT_AVAILABLE = "Disk: not available";

/** Amber at 80% and above, red at 95% and above. */
export function capacityStep(share: number): CapacityStep {
  if (share >= FULL) return "full";
  if (share >= NEARLY_FULL) return "nearly_full";
  return "ok";
}

function line(kind: CapacityKind, label: string, share: number): CapacityLine {
  const step = capacityStep(share);
  return {
    label,
    usedPercent: Math.min(100, Math.round(share * 1000) / 10),
    step,
    advice: step === "ok" ? null : CAPACITY_ADVICE[kind][step],
  };
}

/** Bytes as gigabytes with one decimal, the way both apps print them. */
export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

/**
 * The box's disk, but only when the box says it measured the agents'
 * workspace volume (`scope: "workspace"`). Older boxes report the
 * controller's own small volume in the same field, and a new box that
 * couldn't measure it says `"unknown"`: both read "not available" rather
 * than a wrong figure.
 */
export function workspaceDisk(
  machine: Pick<CloudMachine, "disk">,
): { total_bytes: number; available_bytes: number } | null {
  const disk = machine.disk;
  if (!disk || disk.scope !== "workspace" || disk.total_bytes <= 0) return null;
  return disk;
}

/** Your cloud's three capacity rows, as Console words them. */
export function capacityRows(
  machine: Pick<CloudMachine, "awake" | "room" | "disk">,
): CapacityRows {
  const { awake, room } = machine;
  const disk = workspaceDisk(machine);
  const awakeShare = awake && awake.max > 0 ? awake.running / awake.max : null;
  const memoryShare = room ? room.used_bytes / room.total_bytes : null;
  const diskUsed = disk ? disk.total_bytes - Math.min(disk.available_bytes, disk.total_bytes) : 0;
  return {
    awake:
      awake && awakeShare !== null
        ? line("awake", `Agents awake: ${awake.running} of ${awake.max}`, awakeShare)
        : null,
    memory:
      room && memoryShare !== null
        ? line("memory", `Memory: ${gb(room.used_bytes)} of ${gb(room.total_bytes)}`, memoryShare)
        : null,
    disk: disk
      ? line("disk", `Disk: ${gb(diskUsed)} of ${gb(disk.total_bytes)}`, diskUsed / disk.total_bytes)
      : null,
  };
}
