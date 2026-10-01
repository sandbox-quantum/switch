import { agentExistsOnServer, GatewayError } from '@main/core/switch-servers/gateway-client';
import { withWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { getAgentById } from './getAgentById';
import { updateAgent } from './updateAgent';

/**
 * Link an existing agent to a Switch server the user chose. The link is only
 * persisted when the server provably owns the agent (its `switchAgentId` is a
 * registered agent there). Returns the verification result; `serverId` is
 * written only on `found`. Used to assign a server to legacy agents that were
 * backfilled without one.
 */
export async function assignAgentServer(params: {
  agentId: string;
  serverId: string;
}): Promise<AgentVerifyResult> {
  const agent = await getAgentById(params.agentId);
  if (!agent) {
    throw new Error(`No agent with id ${params.agentId}`);
  }
  if (!agent.switchAgentId) {
    throw new Error(`Agent ${params.agentId} has no Switch agent id to verify`);
  }
  // Resolved before the call, not after it: the workspace the agent would be
  // written into is the one the question has to be asked of, or a `found` here
  // means found somewhere else.
  const workspace = await requireWorkspaceForServer(params.serverId);
  const switchAgentId = agent.switchAgentId;

  let result: AgentVerifyResult;
  try {
    result = (await withWorkspaceSession(workspace.id, (server) =>
      agentExistsOnServer(server, switchAgentId)
    ))
      ? 'found'
      : 'not-found';
  } catch (cause) {
    if (cause instanceof GatewayError && cause.kind === 'unauthorized') {
      return 'unauthenticated';
    }
    throw cause;
  }

  if (result === 'found') {
    await updateAgent({ agentId: params.agentId, workspaceId: workspace.id });
  }
  return result;
}
