import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

export async function getAgentById(agentId: string): Promise<Agent | undefined> {
  const [row] = await db.select().from(agents).where(eq(agents.id, agentId)).limit(1);
  if (!row) return undefined;
  return mapAgentRowToAgent(row);
}
