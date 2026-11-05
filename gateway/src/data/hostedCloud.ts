// Your cloud on Switch web (hosted agents v2): the person's own box and their
// agents' states on it, read from the same owner-only routes Switch Console
// uses. Nothing here is asked with hosted agents v2 off.
//
//   GET  /hosted-machines                   the person's box, as its owner sees it
//   POST /hosted-machines/ensure            wake a resting or put-away box
//   POST /hosted-machines/{id}/lifecycle    start a box its owner stopped
//   GET  /shared-cloud/agents               each of their agents' states on the box
//
// Responses are read field by field, as Console's schema does: a value out of
// shape reads as missing rather than failing the whole panel.

import { useCallback, useEffect, useState } from "react";
import { ApiError, jsonRequest } from "./api";

export type MachineState =
  | "queued"
  | "provisioning"
  | "ready"
  | "stopping"
  | "stopped"
  | "error"
  | "retained"
  | "deleting"
  | "deleted";
export type MachineDesiredState = "running" | "stopped" | "retained" | "deleted";
export type StopReason = "idle" | "owner" | "paused" | "turned_off";

export interface CloudMachine {
  machine_id: string;
  state: MachineState;
  desired_state: MachineDesiredState;
  stop_reason: StopReason | null;
  sleeping: boolean;
  revision: number;
  /** Why it failed to start, in Core's words, when `state` is `error`. */
  error: string | null;
  error_code: string | null;
  /** The ids of the person's agents on the box. */
  agents: string[];
  controller_id: string | null;
  backend?: "vm" | "box";
  room: { used_bytes: number; total_bytes: number } | null;
  awake: { running: number; max: number } | null;
  ai_calls_today: { used: number; cap: number; capped: boolean; resets_at: string } | null;
}

export type CloudAgentState = "working" | "idle" | "waking" | "resting" | "unavailable";

/** One agent's card state, as Core works it out (`visibility/shared_cloud_agents.py`). */
export interface CloudAgent {
  agent_id: string;
  state: CloudAgentState;
  last_reply_at?: string | null;
  room_name?: string | null;
  box_starting?: boolean;
  box_stopped?: boolean;
  waiting_for_room?: boolean;
  paused?: boolean;
  turned_off?: boolean;
  stop_reason?: string | null;
  reset_at?: string | null;
  needs_restart?: boolean;
  needs_check?: boolean;
  memory_stopped?: boolean;
}

const MACHINE_STATES = new Set<string>([
  "queued",
  "provisioning",
  "ready",
  "stopping",
  "stopped",
  "error",
  "retained",
  "deleting",
  "deleted",
]);
const DESIRED_STATES = new Set<string>(["running", "stopped", "retained", "deleted"]);
const STOP_REASONS = new Set<string>(["idle", "owner", "paused", "turned_off"]);
const AGENT_STATES = new Set<string>(["working", "idle", "waking", "resting", "unavailable"]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

function readRoom(value: unknown): CloudMachine["room"] {
  if (!isObject(value)) return null;
  const { used_bytes: used, total_bytes: total } = value;
  return typeof used === "number" && used >= 0 && typeof total === "number" && total > 0
    ? { used_bytes: used, total_bytes: total }
    : null;
}

function readAwake(value: unknown): CloudMachine["awake"] {
  if (!isObject(value)) return null;
  return isCount(value.running) && isCount(value.max)
    ? { running: value.running, max: value.max }
    : null;
}

function readCalls(value: unknown): CloudMachine["ai_calls_today"] {
  if (!isObject(value)) return null;
  const { used, cap, capped, resets_at: resets } = value;
  if (!isCount(used) || !isCount(cap) || cap === 0 || typeof capped !== "boolean") return null;
  // A real time, or the block reads as null: never "resets at Invalid Date".
  if (typeof resets !== "string" || Number.isNaN(Date.parse(resets))) return null;
  return { used, cap, capped, resets_at: resets };
}

/** One machine, or null when its identity or state isn't in shape. */
export function readMachine(value: unknown): CloudMachine | null {
  if (!isObject(value)) return null;
  const { machine_id: id, state, desired_state: desired, revision } = value;
  if (typeof id !== "string" || typeof state !== "string" || !MACHINE_STATES.has(state))
    return null;
  if (typeof desired !== "string" || !DESIRED_STATES.has(desired)) return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  const reason = value.stop_reason;
  return {
    machine_id: id,
    state: state as MachineState,
    desired_state: desired as MachineDesiredState,
    stop_reason:
      typeof reason === "string" && STOP_REASONS.has(reason) ? (reason as StopReason) : null,
    sleeping: value.sleeping === true,
    revision,
    error: typeof value.error === "string" ? value.error : null,
    error_code: typeof value.error_code === "string" ? value.error_code : null,
    agents: Array.isArray(value.agents)
      ? value.agents.filter((agent): agent is string => typeof agent === "string")
      : [],
    controller_id: typeof value.controller_id === "string" ? value.controller_id : null,
    backend: value.backend === "vm" || value.backend === "box" ? value.backend : undefined,
    room: readRoom(value.room),
    awake: readAwake(value.awake),
    ai_calls_today: readCalls(value.ai_calls_today),
  };
}

function readAgent(value: unknown): CloudAgent | null {
  if (!isObject(value)) return null;
  const { agent_id: id, state } = value;
  if (typeof id !== "string" || typeof state !== "string" || !AGENT_STATES.has(state))
    return null;
  const flag = (key: string) => value[key] === true;
  const text = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : null);
  return {
    agent_id: id,
    state: state as CloudAgentState,
    last_reply_at: text("last_reply_at"),
    room_name: text("room_name"),
    box_starting: flag("box_starting"),
    box_stopped: flag("box_stopped"),
    waiting_for_room: flag("waiting_for_room"),
    paused: flag("paused"),
    turned_off: flag("turned_off"),
    stop_reason: text("stop_reason"),
    reset_at: text("reset_at"),
    needs_restart: flag("needs_restart"),
    needs_check: flag("needs_check"),
    memory_stopped: flag("memory_stopped"),
  };
}

/** A machine read as a v2 box, or null: a v1 cloud machine keeps its own (upstream) screens. */
function readBox(value: unknown): CloudMachine | null {
  const machine = readMachine(value);
  return machine && machine.backend === "box" ? machine : null;
}

/**
 * The person's box serving this workspace (null when they have none here), and
 * whether this workspace may have one at all (`available`), which is where a
 * cloud agent can be offered.
 */
export async function fetchCloudPlace(): Promise<{ available: boolean; machine: CloudMachine | null }> {
  const answer = await jsonRequest<{ available?: unknown; machines?: unknown }>("/hosted-machines", "GET");
  const machines = Array.isArray(answer.machines) ? answer.machines : [];
  let machine: CloudMachine | null = null;
  for (const raw of machines) {
    machine = readBox(raw);
    if (machine) break;
  }
  return { available: answer.available === true, machine };
}

/** The person's box serving this workspace, or null when they have none here. */
export async function fetchCloudMachine(): Promise<CloudMachine | null> {
  return (await fetchCloudPlace()).machine;
}

/** Their agents' states on the box; an empty list when they have none there. */
export async function fetchCloudAgents(): Promise<CloudAgent[]> {
  const answer = await jsonRequest<{ agents?: unknown }>("/shared-cloud/agents", "GET");
  const agents = Array.isArray(answer.agents) ? answer.agents : [];
  return agents.map(readAgent).filter((agent): agent is CloudAgent => agent !== null);
}

/**
 * Claim the person's box, wake a resting one or bring back a put-away
 * (retained) one; a box its owner stopped is left as it is. The box as Core
 * answers, read as above: null when it isn't a v2 box.
 */
export async function ensureCloudMachine(): Promise<CloudMachine | null> {
  return readBox(await jsonRequest<unknown>("/hosted-machines/ensure", "POST"));
}

/** Start a box its owner stopped (`ensure` leaves an owner's stop as it is). */
export async function startCloudMachine(machine: CloudMachine): Promise<void> {
  await jsonRequest<unknown>(`/hosted-machines/${encodeURIComponent(machine.machine_id)}/lifecycle`, "POST", {
    action: "start",
    revision: machine.revision,
  });
}

/** How often the panel and the status column read again: boxes rest and wake on their own. */
export const REFRESH_MS = 5000;

export interface CloudView {
  machine: CloudMachine | null;
  /** Whether this workspace may have a box here (`/hosted-machines`' `available`). */
  available: boolean;
  agents: Map<string, CloudAgent>;
  /** False until the first read has finished. */
  loaded: boolean;
  refresh: () => void;
}

/**
 * The person's box and their agents' states, read every few seconds while
 * `enabled` (hosted agents v2 on). With it off, nothing is asked and nothing
 * shows. A read that fails leaves the last good view in place: a box that
 * can't be read for a moment shouldn't blank the panel.
 */
export function useCloudView(enabled: boolean): CloudView {
  const [machine, setMachine] = useState<CloudMachine | null>(null);
  const [available, setAvailable] = useState(false);
  const [agents, setAgents] = useState<Map<string, CloudAgent>>(new Map());
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((value) => value + 1), []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let inFlight = false;
    const read = async () => {
      // One read at a time, and none while the tab is hidden: a slow Core
      // shouldn't pile up requests, and nobody is looking.
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const [place, states] = await Promise.all([fetchCloudPlace(), fetchCloudAgents()]);
        if (cancelled) return;
        setMachine(place.machine);
        setAvailable(place.available);
        setAgents(new Map(states.map((agent) => [agent.agent_id, agent])));
      } catch (error) {
        // 404 with v2 switched off server-side: nothing to show.
        if (!cancelled && error instanceof ApiError && error.status === 404) {
          setMachine(null);
          setAvailable(false);
          setAgents(new Map());
        }
      } finally {
        inFlight = false;
        if (!cancelled) setLoaded(true);
      }
    };
    void read();
    const timer = window.setInterval(() => void read(), REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [enabled, tick]);

  return enabled
    ? { machine, available, agents, loaded, refresh }
    : { machine: null, available: false, agents: new Map(), loaded: false, refresh };
}
