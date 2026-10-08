import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents, workspaces } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

/**
 * Agents with the server hosting each one's workspace. Left-joined, because an
 * unlinked agent has no workspace and still has to be listed.
 */
function agentsWithServer() {
  return db
    .select({ agent: agents, serverId: workspaces.serverId })
    .from(agents)
    .leftJoin(workspaces, eq(agents.workspaceId, workspaces.id));
}

export async function getAgents(locationId?: string): Promise<Agent[]> {
  const query = agentsWithServer();
  const rows = locationId
    ? await query.where(eq(agents.locationId, locationId)).orderBy(desc(agents.updatedAt))
    : await query.orderBy(desc(agents.updatedAt));
  return rows.map((row) => mapAgentRowToAgent(row.agent, row.serverId));
}

/**
 * A directory's agents that belong to one workspace.
 *
 * A directory is a place on disk, not a workspace's territory: the same folder
 * can hold agents belonging to several. Anything answering "do I already have
 * this agent" must therefore ask per workspace — asking per directory reports
 * an agent in workspace A as already onboarded when the target is workspace B,
 * and the candidate is silently dropped (CHOO-2044). Per workspace rather than
 * per server because an agent's name is unique per tenant on the gateway, so
 * two workspaces on one server can each hold a different agent of that name.
 */
export async function getLocationAgentsInWorkspace(
  locationId: string,
  workspaceId: string
): Promise<Agent[]> {
  const rows = await agentsWithServer()
    .where(and(eq(agents.locationId, locationId), eq(agents.workspaceId, workspaceId)))
    .orderBy(desc(agents.updatedAt));
  return rows.map((row) => mapAgentRowToAgent(row.agent, row.serverId));
}
