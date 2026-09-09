import type { SwitchAgentCredentials } from './switch-credentials';

/**
 * Post a message into a room as the agent.
 *
 * Switch Console speaks in a room in exactly two situations, and they are far
 * apart in the tree: the auto-session watcher saying nobody is coming, and the
 * provider room relay putting an agent's approval request where a person can
 * answer it. Both are the same call, so it lives here rather than being written
 * twice with two ideas of what a failure means.
 *
 * Throws on a non-OK response. Every caller is best-effort and logs, but a
 * message the room never received must not read as one it did.
 */
export async function postRoomMessage(
  creds: SwitchAgentCredentials,
  roomId: string,
  content: string
): Promise<void> {
  const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId, content }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}
