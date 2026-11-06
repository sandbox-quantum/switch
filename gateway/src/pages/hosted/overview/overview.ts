import { useEffect } from "react";
import { useHosted } from "../HostedContext";
import { isRecord, stringOrNull } from "../w5shared/operatorFetch";

/** W4's reading of Core's `/shared-cloud/overview` (V4), which the shell
 *  holds. The answer is typed as unknown, so only rows in the shape Core
 *  sends are kept: a row with anything else in it is dropped, never shown
 *  half-read. A missing list is an error, not an empty one, so a broken
 *  answer never reads as "no boxes". Names never come from here (rule 3). */

export const STALE = "Couldn't refresh just now. These figures may be out of date.";
export const LOAD_ERROR = "Couldn't load hosted agents. Reload the page to try again.";
/** How often an open W4 tab asks the shell for a fresh overview. */
export const REFRESH_MS = 30_000;

export type BoxState =
  | "running"
  | "resting"
  | "stopped"
  | "paused"
  | "starting"
  | "stopping"
  | "error"
  | "retired";

const BOX_STATES: readonly BoxState[] = [
  "running",
  "resting",
  "stopped",
  "paused",
  "starting",
  "stopping",
  "error",
  "retired",
];

export interface OverviewPerson {
  userId: string;
  agents: number;
  paused: boolean;
}

export interface OverviewBox {
  box: string;
  user: string;
  workspaces: string[];
  state: BoxState;
  node: string | null;
  memoryUsedBytes: number | null;
  restartsToday: number | null;
  /** The box's memory; null from an older Core or before it has reported. */
  memoryTotalBytes: number | null;
  /** Sessions awake out of the box's limit; null when not reported. */
  awake: { running: number; max: number } | null;
  /** When it last did work, last reported, and was last seen come up (ISO). */
  activeAt: string | null;
  heartbeatAt: string | null;
  runningObservedAt: string | null;
  /** For a put-away box: when it goes for good (ISO); null when not set. */
  retainUntil: string | null;
}

export interface OverviewMachine {
  name: string;
  zone: string;
  memoryUsedPct: number | null;
  memoryBookedPct: number | null;
  memoryTotalBytes: number | null;
  gate: "passed" | "held" | "failed";
  heldMinutes: number | null;
  boxes: number;
  roomForPeople: number | null;
}

export interface OverviewService {
  name: string;
  ready: number;
  wanted: number;
}

export type CellResult = "pass" | "fail" | "unknown";

export interface OverviewIsolation {
  result: "pass" | "fail" | "unknown";
  blocked: number | null;
  total: number | null;
  checkedAt: string | null;
  /** Every direction cell of every well-formed attempt. */
  cells: CellResult[];
}

export interface IsolationVerdict {
  kind: "pass" | "fail" | "unconfirmed" | "none";
  /** Cells counted: the larger of the cells seen and Core's `total`. */
  attempts: number;
  blocked: number;
  through: number;
  couldntRun: number;
}

/** One rule for the Isolation tab and Overview's Kept apart card, taken from
 *  the cells: any cell that got through is a fail; every cell blocked is a
 *  pass; otherwise it's not confirmed. Core's `blocked` counts only passes, so
 *  an attempt that couldn't run never reads as got through, and a cell missing
 *  from a dropped attempt (fewer cells than Core's `total`) counts as couldn't
 *  run, never as blocked (engineer-4). */
export function isolationVerdict(cells: readonly CellResult[], total: number | null): IsolationVerdict {
  const attempts = Math.max(cells.length, total ?? 0);
  const blocked = cells.filter((c) => c === "pass").length;
  const through = cells.filter((c) => c === "fail").length;
  const couldntRun = attempts - blocked - through;
  if (attempts === 0) return { kind: "none", attempts, blocked, through, couldntRun };
  if (through > 0) return { kind: "fail", attempts, blocked, through, couldntRun };
  if (couldntRun > 0) return { kind: "unconfirmed", attempts, blocked, through, couldntRun };
  return { kind: "pass", attempts, blocked, through, couldntRun };
}

function cellsOf(attempts: unknown): CellResult[] {
  if (!Array.isArray(attempts)) return [];
  return attempts.flatMap((item): CellResult[] => {
    if (!isRecord(item) || typeof item.label !== "string" || !Array.isArray(item.results)) return [];
    const cells: CellResult[] = [];
    for (const r of item.results) {
      if (!isRecord(r) || typeof r.direction !== "string") return [];
      cells.push(r.result === "pass" || r.result === "fail" ? r.result : "unknown");
    }
    return cells;
  });
}

export interface OverviewAlert {
  severity: "critical" | "warning";
  title: string;
  raisedAt: string | null;
  open: boolean;
}

export interface Overview {
  people: OverviewPerson[];
  boxes: OverviewBox[];
  machines: OverviewMachine[];
  services: OverviewService[];
  reportStale: boolean;
  isolation: OverviewIsolation;
  alerts: OverviewAlert[];
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function figure(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function strings(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.filter((v): v is string => typeof v === "string");
  return out.length === value.length ? out : null;
}

function person(raw: unknown): OverviewPerson | null {
  if (!isRecord(raw) || !isRecord(raw.agents)) return null;
  const userId = stringOrNull(raw.user_id);
  if (userId === null) return null;
  let agents = 0;
  for (const key of ["working", "idle", "resting", "unavailable"]) {
    const n = count(raw.agents[key]);
    if (n === null) return null;
    agents += n;
  }
  return { userId, agents, paused: raw.paused === true };
}

/** A time Core sent, kept only when it reads as a real date. */
function moment(value: unknown): string | null {
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function awakeOf(value: unknown): OverviewBox["awake"] {
  if (!isRecord(value)) return null;
  const running = count(value.running);
  const max = count(value.max);
  return running === null || max === null || max === 0 ? null : { running, max };
}

function box(raw: unknown): OverviewBox | null {
  if (!isRecord(raw)) return null;
  const id = stringOrNull(raw.box);
  const user = stringOrNull(raw.user);
  const workspaces = strings(raw.workspaces);
  const state = raw.state;
  if (id === null || user === null || workspaces === null) return null;
  if (typeof state !== "string" || !BOX_STATES.includes(state as BoxState)) return null;
  if (raw.node !== null && typeof raw.node !== "string") return null;
  return {
    box: id,
    user,
    workspaces,
    state: state as BoxState,
    node: raw.node as string | null,
    memoryUsedBytes: figure(raw.memory_used_bytes),
    restartsToday: count(raw.restarts_today),
    memoryTotalBytes: figure(raw.memory_total_bytes) || null,
    awake: awakeOf(raw.awake),
    activeAt: moment(raw.active_at),
    heartbeatAt: moment(raw.heartbeat_at),
    runningObservedAt: moment(raw.running_observed_at),
    retainUntil: moment(raw.retain_until),
  };
}

function machine(raw: unknown): OverviewMachine | null {
  if (!isRecord(raw)) return null;
  const name = stringOrNull(raw.name);
  const zone = stringOrNull(raw.zone);
  const boxes = count(raw.boxes);
  const gate = raw.gate;
  if (name === null || zone === null || boxes === null) return null;
  if (gate !== "passed" && gate !== "held" && gate !== "failed") return null;
  return {
    name,
    zone,
    memoryUsedPct: figure(raw.memory_used_pct),
    memoryBookedPct: figure(raw.memory_booked_pct),
    memoryTotalBytes: figure(raw.memory_total_bytes),
    gate,
    heldMinutes: count(raw.held_minutes),
    boxes,
    roomForPeople: count(raw.room_for_people),
  };
}

function service(raw: unknown): OverviewService | null {
  if (!isRecord(raw)) return null;
  const name = stringOrNull(raw.name);
  const ready = count(raw.ready);
  const wanted = count(raw.wanted);
  return name === null || ready === null || wanted === null ? null : { name, ready, wanted };
}

function alert(raw: unknown): OverviewAlert | null {
  if (!isRecord(raw)) return null;
  const title = stringOrNull(raw.title);
  const severity = raw.severity;
  if (title === null || (severity !== "critical" && severity !== "warning")) return null;
  return {
    severity,
    title,
    raisedAt: stringOrNull(raw.raised_at),
    open: raw.cleared_at === null || raw.cleared_at === undefined,
  };
}

function rows<T>(list: unknown, read: (raw: unknown) => T | null): T[] | null {
  if (!Array.isArray(list)) return null;
  return list.flatMap((item) => {
    const row = read(item);
    return row === null ? [] : [row];
  });
}

export function parseOverview(raw: unknown): Overview | null {
  if (!isRecord(raw) || !isRecord(raw.nodes) || !isRecord(raw.isolation)) return null;
  const people = rows(raw.people, person);
  const boxes = rows(raw.boxes, box);
  const machines = rows(raw.nodes.machines, machine);
  const services = rows(raw.nodes.services ?? [], service);
  const alerts = rows(raw.alerts, alert);
  if (!people || !boxes || !machines || !services || !alerts) return null;
  const result = raw.isolation.result;
  return {
    people,
    boxes,
    machines,
    services,
    reportStale: raw.nodes.report_stale === true,
    isolation: {
      result: result === "pass" || result === "fail" ? result : "unknown",
      blocked: count(raw.isolation.blocked),
      total: count(raw.isolation.total),
      checkedAt: stringOrNull(raw.isolation.checked_at),
      cells: cellsOf(raw.isolation.attempts),
    },
    alerts,
  };
}

/** Asks the shell for a fresh overview every 30 seconds while a W4 tab is
 *  open. The shell handles 401 and 403, and keeps the last good answer
 *  (`overviewStale`) when a refresh fails. */
export function useOverviewRefresh(): void {
  const { refresh } = useHosted();
  useEffect(() => {
    const timer = setInterval(() => void refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);
}

/** A byte figure as GB with one decimal, as p10 and p16 show it. */
export function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
