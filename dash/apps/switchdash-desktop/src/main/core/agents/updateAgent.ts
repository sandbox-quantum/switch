import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';
import { mapAgentRowToAgent } from './utils';

export type UpdateAgentParams = {
  agentId: string;
  status?: string | null;
  switchAgentId?: string | null;
  apiEndpoint?: string | null;
  serverId?: string;
  autoApprove?: boolean;
  definitionName?: string | null;
};

type AgentUpdateSet = Parameters<ReturnType<typeof db.update<typeof agents>>['set']>[0];

export async function updateAgent(params: UpdateAgentParams): Promise<Agent | undefined> {
  const set: AgentUpdateSet = { updatedAt: sql`CURRENT_TIMESTAMP` };
  if (params.status !== undefined) set.status = params.status;
  if (params.switchAgentId !== undefined) set.switchAgentId = params.switchAgentId;
  if (params.apiEndpoint !== undefined) set.apiEndpoint = params.apiEndpoint;
  if (params.serverId !== undefined) set.serverId = params.serverId;
  if (params.autoApprove !== undefined) set.autoApprove = params.autoApprove;
  if (params.definitionName !== undefined) set.definitionName = params.definitionName;

  const [row] = await db.update(agents).set(set).where(eq(agents.id, params.agentId)).returning();
  if (!row) return undefined;
  return mapAgentRowToAgent(row);
}
