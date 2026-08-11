import type { AgentRow } from '@main/db/schema';
import { noteAgentName } from '@main/lib/log-name-cache';
import type { Agent } from '@shared/core/agents/agents';

export function mapAgentRowToAgent(row: AgentRow): Agent {
  // Every read and write of an agent passes through here, so the log sink can
  // name an agent id without ever querying for it.
  noteAgentName(row.id, row.name);

  return {
    id: row.id,
    locationId: row.locationId,
    name: row.name,
    providerId: row.providerId,
    switchAgentId: row.switchAgentId ?? null,
    apiEndpoint: row.apiEndpoint ?? null,
    serverId: row.serverId ?? null,
    status: row.status ?? null,
    autoApprove: row.autoApprove,
    providerConfig: row.providerConfig ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
