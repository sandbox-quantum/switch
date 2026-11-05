// Your cloud's wording, ported from Switch Console
// (`features/cloud-agents/your-cloud.ts` and `cloud-machine-state.ts`) so the
// two say the same thing. Change both together.

import type { CloudMachine } from "../../../data/hostedCloud";

/** Room steps (designer): above 80% "A little left", from 95% "Full right now". */
export const NEARLY_FULL = 0.8;
export const FULL = 0.95;

export type RoomStep = "plenty" | "little" | "full";

const ROOM_WORDS: Record<RoomStep, string> = {
  plenty: "Plenty of room",
  little: "A little left",
  full: "Full right now",
};

const HEADING: Record<RoomStep, string> = {
  plenty: "Ready",
  little: "Nearly full",
  full: "Full right now",
};

export type YourCloudView =
  | {
      /** No figures, just a heading and one line. */
      resting: true;
      heading:
        | "Resting"
        | "Paused by Switch"
        | "Turned off by your admin"
        | "Stopped"
        | "Starting…"
        | "Stopping…";
      line: string;
      /** Offer Start, and how: `ensure` wakes a put-away (retained) box or a
       * resting one; `lifecycle` starts a box its owner stopped, which ensure
       * leaves as it is. Absent when Start isn't offered. */
      start?: "ensure" | "lifecycle";
      /** What the Start button says: "Wake" for a resting box with agents. */
      startLabel?: "Start" | "Wake";
    }
  | {
      resting: false;
      heading: string;
      room: { usedPercent: number; step: RoomStep; label: string } | null;
      awake: { label: string } | null;
      aiCalls: { label: string; capped: boolean } | null;
    };

function roomStep(share: number): RoomStep {
  if (share >= FULL) return "full";
  if (share > NEARLY_FULL) return "little";
  return "plenty";
}

const STARTING_STATES: ReadonlySet<CloudMachine["state"]> = new Set(["queued", "provisioning"]);

/**
 * What the panel shows for the box. Figures and "Ready" only while it is up; a
 * box that is stopped, put away, starting or stopping shows its real state,
 * with Start where nothing else would wake it. `time` formats the AI calls'
 * reset in the viewer's own time.
 */
export function yourCloudView(
  machine: Pick<
    CloudMachine,
    | "room"
    | "awake"
    | "ai_calls_today"
    | "sleeping"
    | "stop_reason"
    | "state"
    | "desired_state"
    | "agents"
  >,
  time: (at: Date) => string,
): YourCloudView {
  // An operator's pause wins over the admin's switch, and both over resting.
  if (machine.stop_reason === "paused")
    return { resting: true, heading: "Paused by Switch", line: "Contact your admin" };
  if (machine.stop_reason === "turned_off")
    return {
      resting: true,
      heading: "Turned off by your admin",
      line: "Ask your admin to turn it on",
    };
  const { state, desired_state: desired } = machine;
  const noAgents = machine.agents.length === 0;
  if (state === "retained" || desired === "retained")
    return {
      resting: true,
      heading: "Stopped",
      line: "Start it to add or use an agent.",
      start: "ensure",
    };
  if (STARTING_STATES.has(state))
    return { resting: true, heading: "Starting…", line: "Usually ready in about two minutes." };
  if (state === "stopping")
    return { resting: true, heading: "Stopping…", line: "Start it again once it has stopped." };
  if (machine.sleeping)
    return noAgents
      ? { resting: true, heading: "Resting", line: "Start it to add an agent.", start: "ensure" }
      : {
          // Wake is offered too (PM review, story 2), as on the explorer's
          // resting page; a message to an agent still wakes it by itself.
          resting: true,
          heading: "Resting",
          line: "Starts when you message an agent.",
          start: "ensure",
          startLabel: "Wake",
        };
  if (state === "stopped" && desired === "running")
    return { resting: true, heading: "Starting…", line: "Usually ready in about two minutes." };
  if (state === "stopped")
    return {
      resting: true,
      heading: "Stopped",
      line: "Start it to use your agents.",
      start: "lifecycle",
    };
  if (state !== "ready") return { resting: true, heading: "Stopped", line: "Not running right now." };
  const { room, awake, ai_calls_today: calls } = machine;
  const share = room ? room.used_bytes / room.total_bytes : null;
  const step = share === null ? null : roomStep(share);
  return {
    resting: false,
    heading: step === null ? "Ready" : HEADING[step],
    room:
      share !== null && step !== null
        ? {
            usedPercent: Math.min(100, Math.round(share * 1000) / 10),
            step,
            label: ROOM_WORDS[step],
          }
        : null,
    awake: awake ? { label: `${awake.running} of ${awake.max} awake` } : null,
    aiCalls: calls
      ? {
          label: calls.capped
            ? `Today's AI limit is reached (${calls.cap}). It resets at ${time(new Date(calls.resets_at))}.`
            : `${calls.used} of ${calls.cap} AI calls today, resets at ${time(new Date(calls.resets_at))}`,
          capped: calls.capped,
        }
      : null,
  };
}

/**
 * Whether every agent on the box should read Stopped in the agents list: the
 * panel says Stopped (put away, stopped by its owner, or not running), so the
 * list says the same rather than each agent's Resting (PM review).
 */
export function boxShowsStopped(
  machine: Parameters<typeof yourCloudView>[0],
): boolean {
  return yourCloudView(machine, () => "").heading === "Stopped";
}

/** Switch refuses to start a paused or turned-off box, so Start isn't offered. */
export function startBlocked(machine: Pick<CloudMachine, "stop_reason">): boolean {
  return machine.stop_reason === "paused" || machine.stop_reason === "turned_off";
}

/** The trouble line under the panel, as Console's machine card words it. */
export function machineProblem(
  machine: Pick<CloudMachine, "state" | "error" | "error_code">,
): string | null {
  if (machine.error_code === "disk_full") return "The machine’s disk is full.";
  if (machine.state !== "error") return null;
  if (machine.error_code === "machine_needs_attention")
    return "The machine needs attention. Contact your server administrator.";
  if (machine.error_code === "machine_connect_timeout")
    return "The machine did not connect in time. Retry, and if it fails again contact your server administrator.";
  return machine.error ?? "The machine could not start.";
}
