import { hostSessions, LIST_SCRIPT } from '@switch-console/agent-providers';
import type { Session } from '@switch-console/shared/session-v1';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { connectRemoteAgent } from '@main/core/agents/connect-remote-agent';
import { getAgentById } from '@main/core/agents/getAgentById';
import { LocalExecutionContext } from '@main/core/execution-context/local-execution-context';
import type { IExecutionContext } from '@main/core/execution-context/types';

async function agentContext(
  agentId: string
): Promise<{ ctx: IExecutionContext; switchAgentId: string }> {
  const agent = await getAgentById(agentId);
  if (!agent?.switchAgentId) throw new Error('This agent is not linked to Switch.');
  const location = await getAgentLocation(agent);
  const ctx = location.sshHost
    ? (await connectRemoteAgent(agent)).ctx
    : new LocalExecutionContext();
  return { ctx, switchAgentId: agent.switchAgentId };
}

/**
 * Each session this agent has on its host, as its host last recorded it: the
 * status it reported, whether its host is running now, and the room it was
 * last handed a message in.
 */
export async function listHostSessions(agentId: string): Promise<Session[]> {
  const { ctx, switchAgentId } = await agentContext(agentId);
  const { stdout } = await ctx.exec('node', ['-e', LIST_SCRIPT, switchAgentId, '']);
  return hostSessions(JSON.parse(stdout));
}
