import { serverIdForWorkspace } from '@main/core/workspaces/workspaces-store';
import type { AgentRow } from '@main/db/schema';
import { noteAgentName } from '@main/lib/log-name-cache';
import type { Agent } from '@shared/core/agents/agents';

/**
 * `serverId` is the server hosting the agent's workspace. It is a join away
 * from the row rather than on it, so the caller resolves it — the list reads
 * join, the single-row reads use {@link mapAgentRow}.
 */
export function mapAgentRowToAgent(row: AgentRow, serverId: string | null): Agent {
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
    workspaceId: row.workspaceId ?? null,
    serverId,
    status: row.status ?? null,
    autoApprove: row.autoApprove,
    ownerName: row.ownerName ?? null,
    providerConfig: row.providerConfig ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** {@link mapAgentRowToAgent} for one row, looking its server up. */
export async function mapAgentRow(row: AgentRow): Promise<Agent> {
  return mapAgentRowToAgent(row, await serverIdForWorkspace(row.workspaceId));
}
