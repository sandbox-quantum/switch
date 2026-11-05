// An agent's state on the person's cloud, worded as Switch Console words it
// (`features/shared-cloud/shared-cloud-state.ts`). Core works the state out
// (`GET /shared-cloud/agents`); this only words it. Change both together.

import type { CloudAgent } from "../../../data/hostedCloud";

export type CloudTone = "working" | "idle" | "waking" | "resting" | "problem" | "off";

export interface CloudPresentation {
  label: string;
  /** What the state means for the person, in one line; none for "Stopped". */
  detail: string | null;
  tone: CloudTone;
  /** "last reply 4 min ago", or null when it has never replied or is replying now. */
  when: string | null;
}

/** A resting agent on a box Your cloud shows as Stopped. */
export const BOX_STOPPED: CloudPresentation = {
  label: "Stopped",
  detail: "Your cloud is stopped",
  tone: "resting",
  when: null,
};

/** An agent on the box with no state from Core: its owner stopped it
 * (Console's `managed-agent-state.ts`: "Stopped", no second line). */
export const OWNER_STOPPED: CloudPresentation = {
  label: "Stopped",
  detail: null,
  tone: "idle",
  when: null,
};

export function cloudPresentation(agent: CloudAgent, now: Date): CloudPresentation {
  const when =
    agent.state === "working" || !agent.last_reply_at
      ? null
      : `last reply ${replyAgo(agent.last_reply_at, now)}`;
  switch (agent.state) {
    case "working":
      return {
        label: "Working",
        detail: agent.room_name ? `Replying in ${agent.room_name}` : "Replying now",
        tone: "working",
        when,
      };
    case "idle":
      return { label: "Idle", detail: "Replies straight away", tone: "idle", when };
    case "waking":
      return {
        label: "Back in a moment",
        detail: agent.box_starting
          ? "Starting your cloud"
          : agent.waiting_for_room
            ? "Waiting for room"
            : "Starting up",
        tone: "waking",
        when,
      };
    case "resting":
      return {
        label: "Resting",
        detail: agent.box_stopped ? "Starts when messaged" : "Back when messaged",
        tone: "resting",
        when,
      };
    case "unavailable":
      if (agent.paused)
        return { label: "Paused by Switch", detail: "Contact your admin", tone: "problem", when };
      if (agent.turned_off)
        return {
          label: "Turned off by your admin",
          detail: "Ask your admin to turn it on",
          tone: "off",
          when,
        };
      if (agent.stop_reason === "daily_cap_reached")
        return {
          label: "Can't reply right now",
          detail: "Today's AI limit reached",
          tone: "problem",
          when,
        };
      if (agent.stop_reason === "budget_reached")
        return {
          label: "Can't reply right now",
          detail:
            agent.reset_at && !Number.isNaN(Date.parse(agent.reset_at))
              ? `Budget reached, resets ${resetDate(agent.reset_at)}`
              : "Budget reached",
          tone: "problem",
          when,
        };
      if (agent.stop_reason === "login_needed")
        // Console's repair wording needs sealing, which is a later slice.
        return {
          label: "Can't reply right now",
          detail: "Set up your AI provider again",
          tone: "problem",
          when,
        };
      if (agent.stop_reason === "cant_reach")
        return {
          label: "Can't reply right now",
          detail: "Can't reach your cloud",
          tone: "problem",
          when,
        };
      return {
        label: "Can't reply right now",
        detail: agent.needs_restart
          ? "Needs a restart"
          : agent.memory_stopped
            ? "Stopped: used too much memory"
            : agent.needs_check
              ? "Open it to see why"
              : "Try again in a few minutes",
        tone: "problem",
        when,
      };
  }
}

/** A budget's reset as a short date, in the person's own time: "12 Nov". */
function resetDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** "just now", "4 min ago", "2 h ago", "yesterday", "3 days ago". */
export function replyAgo(iso: string, now: Date): string {
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (Number.isNaN(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

/**
 * What the agents list shows for one agent: its state from Core, "Stopped"
 * for an agent on the box its owner stopped (Core leaves those out) or on a
 * box the panel shows as Stopped (`boxStopped`), or null for an agent not on
 * the person's cloud at all.
 */
export function cloudStatusFor(
  agentId: string,
  states: ReadonlyMap<string, CloudAgent>,
  onBox: ReadonlySet<string>,
  now: Date,
  boxStopped = false,
): CloudPresentation | null {
  const agent = states.get(agentId);
  // A resting agent on a stopped box won't start when messaged (Console's
  // `sharedCloudPresentation` says the same); a failure keeps its own words.
  if (boxStopped && onBox.has(agentId) && agent?.state === "resting") return BOX_STOPPED;
  if (agent) return cloudPresentation(agent, now);
  return onBox.has(agentId) ? OWNER_STOPPED : null;
}
