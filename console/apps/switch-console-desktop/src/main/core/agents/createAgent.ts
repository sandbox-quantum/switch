import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import type { Agent, CreateAgentParams } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

/**
 * Insert an agent row. Main-process internal, and deliberately not an RPC
 * method: it validates nothing and emits no `agent:created`, so a row made
 * this way is one the rest of the app never hears about. Callers come in
 * through `addAgent`, `onboardAgent`, `attachConfiguredAgents` or
 * `adoptSubagent`, which own the checks and the lifecycle event.
 */
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
      autoApprove: params.autoApprove,
      ownerName: params.ownerName ?? null,
      providerConfig: params.providerConfig ?? null,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  return mapAgentRowToAgent(row);
}
