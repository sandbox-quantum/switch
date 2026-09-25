import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents, sessions, type SessionRow, workspaces } from '@main/db/schema';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export type SessionWithAgent = {
  row: SessionRow;
  locationId: string;
  providerId: AgentProviderId;
  /** The owning agent's `name` — the session's identity source. The creds slug
   * and `--agent` launch name derive from it, read live, not from a frozen tag. */
  name: string;
  /** The workspace the owning agent belongs to; null for an agent not linked to
   * Switch. This is what a call about the session is addressed with — a server
   * can host several workspaces and answers for only the selected one. */
  workspaceId: string | null;
  /** The server hosting the agent's workspace; null once that server has been
   * removed, which leaves the agent's endpoint and token pointing at something
   * that no longer exists. */
  serverId: string | null;
};

/**
 * Loads a session row joined with its owning agent, exposing the agent's
 * `locationId`, `providerId`, and `name` (denormalised onto the session view).
 */
export async function loadSessionWithAgent(
  sessionId: string
): Promise<SessionWithAgent | undefined> {
  const [joined] = await db
    .select({
      session: sessions,
      locationId: agents.locationId,
      providerId: agents.providerId,
      name: agents.name,
      workspaceId: agents.workspaceId,
      serverId: workspaces.serverId,
    })
    .from(sessions)
    .innerJoin(agents, eq(sessions.agentId, agents.id))
    // Left: an unlinked agent has no workspace and its sessions still load.
    .leftJoin(workspaces, eq(agents.workspaceId, workspaces.id))
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (!joined) return undefined;
  return {
    row: joined.session,
    locationId: joined.locationId,
    providerId: joined.providerId,
    name: joined.name,
    workspaceId: joined.workspaceId,
    serverId: joined.serverId,
  };
}
