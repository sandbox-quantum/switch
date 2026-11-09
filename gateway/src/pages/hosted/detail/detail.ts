// The Hosted machine and box detail pages: what each shows, worked out from
// the one overview read (Core's `/shared-cloud/overview`) the shell already
// holds. Current figures only: Core keeps the latest cluster report and each
// box's latest report, never readings over time. Nothing here names a person,
// a file or a conversation; ids are keyed ids, shown short.

import type { CapacityLine } from "../../agents/cloud/capacity";

export type BoxState =
  | "running"
  | "resting"
  | "stopped"
  | "paused"
  | "starting"
  | "stopping"
  | "error"
  | "retired";

export type AgentBucket = "working" | "idle" | "resting" | "unavailable";
export type AgentCounts = Record<AgentBucket, number>;

/** What a detail page needs of a box row: the overview's box, with its owner's agent counts. */
export interface DetailBox {
  box: string;
  user: string;
  workspaces: string[];
  state: BoxState;
  node: string | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  restartsToday: number | null;
  awake: { running: number; max: number } | null;
  activeAt: string | null;
  heartbeatAt: string | null;
  runningObservedAt: string | null;
  disk?: { total_bytes: number; available_bytes: number; scope?: "workspace" | "unknown" } | null;
}

/** What a detail page needs of a node. */
export interface DetailMachine {
  name: string;
  /** The node's keyed id: its page's address, and its audit target. */
  machine: string;
  zone: string;
  memoryUsedPct: number | null;
  memoryBookedPct: number | null;
}

export interface DetailOverview {
  boxes: DetailBox[];
  machines: DetailMachine[];
  /** Each box owner's agents by state, by the owner's keyed id (one box each). */
  agentsByUser: Map<string, AgentCounts>;
  reportAt: string | null;
  reportStale: boolean;
}

/** One slice of a donut: its words, its count, and the filter a click applies. */
export interface Slice {
  key: string;
  label: string;
  count: number;
}

/** The box states a donut counts, in a fixed order, with the words the Boxes tab uses. */
export const BOX_STATE_SLICES: { key: "awake" | "resting" | "stopped" | "other"; label: string }[] = [
  { key: "awake", label: "Awake" },
  { key: "resting", label: "Resting" },
  { key: "stopped", label: "Stopped" },
  { key: "other", label: "Paused, failed or put away" },
];

export const AGENT_SLICES: { key: AgentBucket; label: string }[] = [
  { key: "working", label: "Working" },
  { key: "idle", label: "Idle" },
  { key: "resting", label: "Resting" },
  { key: "unavailable", label: "Can't reply" },
];

/** Which donut slice a box state falls in. */
export function boxSlice(state: BoxState): (typeof BOX_STATE_SLICES)[number]["key"] {
  if (state === "running" || state === "starting") return "awake";
  if (state === "resting") return "resting";
  if (state === "stopped" || state === "stopping") return "stopped";
  return "other";
}

export const NO_AGENTS: AgentCounts = { working: 0, idle: 0, resting: 0, unavailable: 0 };

function addCounts(a: AgentCounts, b: AgentCounts): AgentCounts {
  return {
    working: a.working + b.working,
    idle: a.idle + b.idle,
    resting: a.resting + b.resting,
    unavailable: a.unavailable + b.unavailable,
  };
}

/** Boxes by state, as donut slices; empty slices are kept so the legend reads the same. */
export function boxSlices(boxes: readonly Pick<DetailBox, "state">[]): Slice[] {
  return BOX_STATE_SLICES.map(({ key, label }) => ({
    key,
    label,
    count: boxes.filter((b) => boxSlice(b.state) === key).length,
  }));
}

export function agentSlices(counts: AgentCounts): Slice[] {
  return AGENT_SLICES.map(({ key, label }) => ({ key, label, count: counts[key] }));
}

/** The Machines tab's alert line: used memory above 85% (its footnote). */
export const MACHINE_USED_ALERT_PCT = 85;

/**
 * "Memory used: 62%": a node's percentage bar, red only where the Machines
 * tab already warns (used above 85%), so the two pages never disagree.
 * Booked is a planning figure and never warns.
 */
function percentLine(label: string, pct: number, warn: boolean): CapacityLine {
  const share = Math.max(0, pct) / 100;
  const step = warn && pct > MACHINE_USED_ALERT_PCT ? "full" : "ok";
  return {
    label: `${label}: ${Math.round(Math.min(100, Math.max(0, pct)))}%`,
    usedPercent: Math.min(100, Math.round(share * 1000) / 10),
    step,
    advice: null,
  };
}

export interface MachineDetail {
  machine: DetailMachine;
  boxes: DetailBox[];
  boxSlices: Slice[];
  agentSlices: Slice[];
  /** Null when the cluster report doesn't carry the figure: "Not available". */
  memoryUsed: CapacityLine | null;
  memoryBooked: CapacityLine | null;
}

/** A node's page, by its keyed id; null when no node has that id (gone, or never existed). */
export function machineDetail(overview: DetailOverview, machineId: string): MachineDetail | null {
  const machine = overview.machines.find((m) => m.machine === machineId);
  if (!machine) return null;
  const boxes = overview.boxes.filter((b) => b.node === machine.name);
  const agents = boxes.reduce(
    (sum, b) => addCounts(sum, overview.agentsByUser.get(b.user) ?? NO_AGENTS),
    NO_AGENTS,
  );
  return {
    machine,
    boxes,
    boxSlices: boxSlices(boxes),
    agentSlices: agentSlices(agents),
    memoryUsed:
      machine.memoryUsedPct === null ? null : percentLine("Memory used", machine.memoryUsedPct, true),
    memoryBooked:
      machine.memoryBookedPct === null
        ? null
        : percentLine("Memory booked", machine.memoryBookedPct, false),
  };
}

export interface BoxDetail {
  box: DetailBox;
  /** The node it runs on, when the overview still has it. */
  machine: DetailMachine | null;
  agentSlices: Slice[];
}

/** A box's page, by its keyed id; null when no box has that id. */
export function boxDetail(overview: DetailOverview, boxId: string): BoxDetail | null {
  const box = overview.boxes.find((b) => b.box === boxId);
  if (!box) return null;
  return {
    box,
    machine: overview.machines.find((m) => m.name === box.node) ?? null,
    agentSlices: agentSlices(overview.agentsByUser.get(box.user) ?? NO_AGENTS),
  };
}

/** A box's memory as Your cloud words it ("Memory: 1.2 GB of 4.0 GB"), or null when either figure is missing. */
export function boxMemory(
  box: Pick<DetailBox, "memoryUsedBytes" | "memoryTotalBytes">,
): { used_bytes: number; total_bytes: number } | null {
  const { memoryUsedBytes: used, memoryTotalBytes: total } = box;
  if (used === null || total === null || total <= 0) return null;
  return { used_bytes: Math.min(used, total), total_bytes: total };
}

/** "Running since" shows only while the box is awake. */
export function runningSince(box: Pick<DetailBox, "state" | "runningObservedAt">): string | null {
  return box.state === "running" ? box.runningObservedAt : null;
}

export const NOT_AVAILABLE = "Not available";
export const MACHINE_GONE = "This machine isn't in the latest report. It may have been removed.";
export const BOX_GONE = "This box isn't in the overview any more. It may have been removed.";
