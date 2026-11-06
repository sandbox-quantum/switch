// Reads what the detail pages need from the overview answer the shell holds
// (`useHosted().overview`, raw JSON). Like the tabs' own reader, a row that
// isn't in the shape Core sends is dropped, never shown half-read, and a
// figure out of shape reads as missing ("Not available"), never as zero.

import { isRecord, stringOrNull } from "../w5shared/operatorFetch";
import type {
  AgentCounts,
  BoxState,
  DetailBox,
  DetailMachine,
  DetailOverview,
} from "./detail";

const BOX_STATES = new Set<string>([
  "running",
  "resting",
  "stopped",
  "paused",
  "starting",
  "stopping",
  "error",
  "retired",
]);

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function figure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** An ISO time Core sent, or null: never "Invalid Date" on the page. */
function moment(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : null;
}

function awakeOf(value: unknown): DetailBox["awake"] {
  if (!isRecord(value)) return null;
  const running = count(value.running);
  const max = count(value.max);
  return running !== null && max !== null && max > 0 ? { running, max } : null;
}

function diskOf(value: unknown): DetailBox["disk"] {
  if (!isRecord(value)) return null;
  const total = figure(value.total_bytes);
  const available = figure(value.available_bytes);
  if (total === null || available === null) return null;
  const scope = value.scope === "workspace" || value.scope === "unknown" ? value.scope : undefined;
  return { total_bytes: total, available_bytes: available, ...(scope ? { scope } : {}) };
}

function box(raw: unknown): DetailBox | null {
  if (!isRecord(raw)) return null;
  const id = stringOrNull(raw.box);
  const user = stringOrNull(raw.user);
  const workspaces = strings(raw.workspaces);
  const state = raw.state;
  if (id === null || user === null || workspaces === null) return null;
  if (typeof state !== "string" || !BOX_STATES.has(state)) return null;
  if (raw.node !== null && raw.node !== undefined && typeof raw.node !== "string") return null;
  return {
    box: id,
    user,
    workspaces,
    state: state as BoxState,
    node: typeof raw.node === "string" ? raw.node : null,
    memoryUsedBytes: figure(raw.memory_used_bytes),
    memoryTotalBytes: figure(raw.memory_total_bytes) || null,
    restartsToday: count(raw.restarts_today),
    awake: awakeOf(raw.awake),
    activeAt: moment(raw.active_at),
    heartbeatAt: moment(raw.heartbeat_at),
    runningObservedAt: moment(raw.running_observed_at),
    disk: diskOf(raw.disk),
  };
}

function machine(raw: unknown): DetailMachine | null {
  if (!isRecord(raw)) return null;
  const name = stringOrNull(raw.name);
  const id = stringOrNull(raw.machine);
  const zone = stringOrNull(raw.zone);
  if (name === null || id === null || zone === null) return null;
  return {
    name,
    machine: id,
    zone,
    memoryUsedPct: figure(raw.memory_used_pct),
    memoryBookedPct: figure(raw.memory_booked_pct),
  };
}

function agentCounts(raw: unknown): AgentCounts | null {
  if (!isRecord(raw)) return null;
  const working = count(raw.working);
  const idle = count(raw.idle);
  const resting = count(raw.resting);
  const unavailable = count(raw.unavailable);
  if (working === null || idle === null || resting === null || unavailable === null) return null;
  return { working, idle, resting, unavailable };
}

function rows<T>(list: unknown, read: (raw: unknown) => T | null): T[] {
  return Array.isArray(list) ? list.flatMap((item) => read(item) ?? []) : [];
}

/** The detail pages' view of the overview, or null when the answer isn't one. */
export function readDetail(raw: unknown): DetailOverview | null {
  if (!isRecord(raw) || !isRecord(raw.nodes) || !Array.isArray(raw.boxes)) return null;
  const agentsByUser = new Map<string, AgentCounts>();
  for (const person of Array.isArray(raw.people) ? raw.people : []) {
    if (!isRecord(person)) continue;
    const userId = stringOrNull(person.user_id);
    const counts = agentCounts(person.agents);
    if (userId !== null && counts !== null) agentsByUser.set(userId, counts);
  }
  return {
    boxes: rows(raw.boxes, box),
    machines: rows(raw.nodes.machines, machine),
    agentsByUser,
    reportAt: moment(raw.nodes.report_at),
    reportStale: raw.nodes.report_stale === true,
  };
}
