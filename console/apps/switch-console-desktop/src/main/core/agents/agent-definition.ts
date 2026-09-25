import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { getAgentLocation } from './agent-location';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgentById } from './getAgentById';

/**
 * Read an agent's on-disk definition attributes (model, effort, tools, system
 * prompt, …) so the Settings tab can prefill its editable Advanced section.
 * Returns null when the provider has no definition concept, the agent carries no
 * definition name, or the definition file is absent — the caller renders an
 * empty form in that case (CHOO-1440).
 */
export async function readAgentDefinition(agentId: string): Promise<RepoAgentAttributes | null> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  const behavior = getPlugin(agent.providerId).behavior.repoAgents;
  if (!behavior || !agent.name) return null;

  const location = await getAgentLocation(agent);
  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    return await behavior.readDefinition(workspace.fs, agent.name);
  } finally {
    workspace.close();
  }
}

/**
 * Rewrite an agent's on-disk definition with new Advanced attributes, preserving
 * its identity (name) and description. The name is immutable — it is the agent's
 * `--agent <name>` handle and its Switch identity — so only the provider's
 * advanced attributes change. Fails loud for a provider without definitions or an
 * agent with no definition name (there is nothing to edit).
 */
export async function updateAgentDefinition(params: {
  agentId: string;
  attributes: RepoAgentAttributes;
}): Promise<void> {
  const agent = await getAgentById(params.agentId);
  if (!agent) throw new Error(`No agent with id ${params.agentId}`);

  const behavior = getPlugin(agent.providerId).behavior.repoAgents;
  if (!behavior || !agent.name) {
    throw new Error(`Agent ${params.agentId} has no editable on-disk definition.`);
  }

  const location = await getAgentLocation(agent);
  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    const current = await behavior.readDefinition(workspace.fs, agent.name);
    const description = typeof current?.description === 'string' ? current.description : '';
    await behavior.writeDefinition(workspace.fs, {
      ...params.attributes,
      name: agent.name,
      description,
    });
  } finally {
    workspace.close();
  }
}
