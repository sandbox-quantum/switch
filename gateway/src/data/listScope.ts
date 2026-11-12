import type { AgentSummary, RoomSummary } from "./api";
import type { Capabilities } from "./capabilities";

/** How much of the workspace's agents and rooms someone is shown: all of
 * them to whoever administers it, and to a member only their own. The
 * Overview counts and the Agents and Rooms lists narrow by the same rule, so
 * a count is the number of rows its list shows. Users is never narrowed:
 * everyone in a workspace may see who else is in it. */
export type ListScope = "workspace" | "yours";

export function listScopeOf(caps: Capabilities): ListScope {
  return caps.administersWorkspace ? "workspace" : "yours";
}

/** A member's agents are the ones they own. A sub-agent is owned by whoever
 * added it, so theirs are counted with them. */
export function agentsInScope(
  agents: readonly AgentSummary[],
  scope: ListScope,
  userId: string,
): readonly AgentSummary[] {
  return scope === "workspace" ? agents : agents.filter((agent) => agent.owner_id === userId);
}

/** A member's rooms are the ones they take part in, as the server reports
 * it: they own the room, are in it, or own an agent in it. A public room
 * they only read is the workspace's, not theirs. */
export function roomsInScope(
  rooms: readonly RoomSummary[],
  scope: ListScope,
): readonly RoomSummary[] {
  return scope === "workspace" ? rooms : rooms.filter((room) => room.viewer_is_member);
}
