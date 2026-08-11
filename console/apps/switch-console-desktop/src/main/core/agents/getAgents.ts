import { and, desc, eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

export async function getAgents(locationId?: string): Promise<Agent[]> {
  const rows = locationId
    ? await db
        .select()
        .from(agents)
        .where(eq(agents.locationId, locationId))
        .orderBy(desc(agents.updatedAt))
    : await db.select().from(agents).orderBy(desc(agents.updatedAt));
  return rows.map(mapAgentRowToAgent);
}

/**
 * A directory's agents that belong to one Switch server.
 *
 * A directory is a place on disk, not a server's territory: the same folder can
 * hold agents registered against several servers. Anything answering "do I
 * already have this agent" must therefore ask per server — asking per directory
 * reports an agent on server A as already onboarded when the target is server B,
 * and the candidate is silently dropped (CHOO-2044).
 */
export async function getLocationAgentsOnServer(
  locationId: string,
  serverId: string
): Promise<Agent[]> {
  const rows = await db
    .select()
    .from(agents)
    .where(and(eq(agents.locationId, locationId), eq(agents.serverId, serverId)))
    .orderBy(desc(agents.updatedAt));
  return rows.map(mapAgentRowToAgent);
}
