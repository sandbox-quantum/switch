import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import type { RemoteAgentSummary } from '@shared/core/switch-servers/switch-servers';

/** This install's record of a Switch agent, which is where its provider is
 * known — the server says what type an agent is, not what runs it here. */
export function localAgentFor(switchAgentId: string, workspaceId: string) {
  return (
    agentsStore.agentsInWorkspace(workspaceId).find((a) => a.switchAgentId === switchAgentId) ??
    null
  );
}

export function agentNameFor(
  switchAgentId: string,
  workspaceId: string,
  remoteById: Map<string, RemoteAgentSummary>
): string {
  return (
    localAgentFor(switchAgentId, workspaceId)?.name ??
    remoteById.get(switchAgentId)?.name ??
    'Agent'
  );
}
