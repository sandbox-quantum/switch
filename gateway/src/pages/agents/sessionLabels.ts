import type { AgentSessionDetail } from "../../data/api";

/** Who runs a session, when it is not the agent itself. */
export interface SessionRunner {
  label: string;
  /** The longer form, for a tooltip. */
  detail: string;
}

/**
 * A controller-backed agent's sessions are run by the agents controller of the
 * machine it is placed on, not by a connection of its own; say so, and name the
 * controller. Null for every other session, which the agent runs itself.
 */
export function sessionRunner(session: AgentSessionDetail): SessionRunner | null {
  if (session.lifecycle !== "controller") return null;
  const place = session.room_id
    ? "working in this room"
    : "running, with no session working in a room yet";
  return {
    label: "Run by a machine",
    detail: session.controller_id
      ? `Run by agents controller ${session.controller_id} on the machine the agent is placed on, ${place}.`
      : `Run by the agents controller of the machine the agent is placed on, ${place}.`,
  };
}

/** Where a session works: its room, or what a session in no room means for it. */
export function sessionPlace(session: AgentSessionDetail): string {
  if (session.room_name) return session.room_name;
  if (session.room_id) return session.room_id;
  return session.lifecycle === "controller" ? "Not in a room yet" : "Room-agnostic";
}
