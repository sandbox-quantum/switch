import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import type { Agent, CreateAgentParams } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

export async function createAgent(params: CreateAgentParams): Promise<Agent> {
  const [row] = await db
    .insert(agents)
    .values({
      id: params.id,
      locationId: params.locationId,
      name: params.name,
      providerId: params.providerId,
      switchAgentId: params.switchAgentId,
      apiEndpoint: params.apiEndpoint,
      serverId: params.serverId,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  return mapAgentRowToAgent(row);
}
