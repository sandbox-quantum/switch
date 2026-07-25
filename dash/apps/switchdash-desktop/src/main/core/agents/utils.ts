import type { AgentRow } from '@main/db/schema';
import type { Agent } from '@shared/core/agents/agents';

export function mapAgentRowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    providerId: row.providerId,
    definitionName: row.definitionName ?? null,
    switchAgentId: row.switchAgentId ?? null,
    apiEndpoint: row.apiEndpoint ?? null,
    serverId: row.serverId ?? null,
    status: row.status ?? null,
    autoApprove: row.autoApprove,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
