import { desc, eq } from 'drizzle-orm';
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
