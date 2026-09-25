import { randomUUID } from 'node:crypto';
import { agentEvents } from '@main/core/agents/agent-events';
import { createAgent } from '@main/core/agents/createAgent';
import { getLocationAgentsInWorkspace } from '@main/core/agents/getAgents';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { fetchAgentDetail } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { requireWorkspace } from '@main/core/workspaces/workspaces-store';
import type { Agent } from '@shared/core/agents/agents';

export async function adoptSubagent(
  parent: Agent,
  name: string,
  switchAgentId: string
): Promise<void> {
  if (!parent.workspaceId) throw new Error('The subagent’s Switch workspace is missing.');
  const local = await getLocationAgentsInWorkspace(parent.locationId, parent.workspaceId);
  const existing = local.find((agent) => agent.switchAgentId === switchAgentId);
  if (existing) {
    if (existing.name !== name || existing.providerId !== parent.providerId)
      throw new Error('The subagent identity is already linked to different execution settings.');
    remoteSessionReconciler.start(existing.id);
    return;
  }
  if (local.some((agent) => agent.name === name))
    throw new Error('This subagent name is already linked to a different Switch identity.');
  const workspace = await requireWorkspace(parent.workspaceId);
  const server = await getServer(workspace.serverId);
  if (!server) throw new Error('The subagent’s Switch server is missing.');
  const remote = await fetchAgentDetail(server, switchAgentId);
  if (remote.id !== switchAgentId)
    throw new Error('Switch returned a different subagent identity.');
  const agent = await createAgent({
    id: randomUUID(),
    locationId: parent.locationId,
    name,
    providerId: parent.providerId,
    switchAgentId,
    apiEndpoint: parent.apiEndpoint,
    workspaceId: parent.workspaceId,
    autoApprove: parent.autoApprove,
    ownerName: remote.ownerName,
    providerConfig: parent.providerConfig,
  });
  agentEvents._emit('agent:created', agent, 'unknown');
  remoteSessionReconciler.start(agent.id);
}
