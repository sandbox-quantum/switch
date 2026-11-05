// Start, stop, restart and rename for an agent on the person's Switch cloud
// box, from Switch web: the same calls Switch Console makes, so an agent made
// in either app can be managed from either. Hosted agents v2 only. Delete is
// `pages/agents/cloud/cloudDelete.ts`, which minds the box's login.

import { fetchManagedAgents, ManagementApiError, updateManagedAgent } from "./management";

export function setCloudAgentRunning(agentId: string, running: boolean): Promise<unknown> {
  return updateManagedAgent(agentId, { desired_state: running ? "running" : "stopped" });
}

/** Restart is stop, then start, as Console does it. It stops at the first refusal. */
export async function restartCloudAgent(agentId: string): Promise<void> {
  await setCloudAgentRunning(agentId, false);
  await setCloudAgentRunning(agentId, true);
}

/** Whether the agent is meant to be running, as its owner last set it; null when it isn't managed. */
export async function fetchCloudAgentRunning(agentId: string): Promise<boolean | null> {
  const agent = (await fetchManagedAgents()).find((a) => a.agent_id === agentId);
  return agent ? agent.desired_state === "running" : null;
}

/** The error a non-management route sent, in its own words where it gave them. */
async function routeError(res: Response): Promise<Error> {
  const body: unknown = await res.json().catch(() => null);
  const detail =
    body && typeof body === "object" && "detail" in body
      ? (body as { detail: unknown }).detail
      : null;
  return new Error(typeof detail === "string" ? detail : `${res.status} ${res.statusText}`);
}

/**
 * Renames a cloud agent by its display name only (`PUT /agents/{id}/display-name`),
 * as Console does. Its name stays: on a box it is the agent's folder and the
 * key the file explorer opens it by. Blank clears the display name.
 */
export async function setCloudAgentDisplayName(
  agentId: string,
  displayName: string,
): Promise<void> {
  const trimmed = displayName.trim();
  const res = await fetch(`/gateway/agents/${encodeURIComponent(agentId)}/display-name`, {
    method: "PUT",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ display_name: trimmed || null }),
  });
  if (!res.ok) throw await routeError(res);
}

/** Words for a refusal: Core's own message for a management refusal, else the error's. */
export function refusalText(error: unknown): string {
  if (error instanceof ManagementApiError) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return "That didn't go through. Try again.";
}
