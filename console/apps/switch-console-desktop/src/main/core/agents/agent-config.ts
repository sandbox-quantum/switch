import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { listAutoSessionAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { providerConfigFromAttributes } from '@shared/core/agents/agent-provider-config';
import type { AgentConfigFile } from './agent-config-file';
import { writeAgentConfigFile, type AgentTemplateOrigin } from './agent-config-file';
import { readRequiredAgentConfig, withAgentWorkspace } from './agent-launch-config';
import { getAgentById } from './getAgentById';
import { ensureRemoteWatcher } from './remote-watcher';
import { setAgentProviderConfig } from './setAgentProviderConfig';

/**
 * An agent's configuration, read and written where it lives: the committed
 * config file in its working directory (CHOO-2228).
 *
 * The file is the only record. Nothing is generated from it on disk and nothing
 * is read back into it: each launch builds what the provider needs from the file
 * directly. So reading never writes, and the only writes are the ones a person
 * asked for.
 */

export async function readAgentConfig(agentId: string): Promise<AgentConfigFile> {
  return withAgentWorkspace(agentId, (agent, fs) => readRequiredAgentConfig(agent, fs));
}

/** The template the agent was created from, or null for an agent created without one. */
export async function readAgentTemplateOrigin(
  agentId: string
): Promise<AgentTemplateOrigin | null> {
  return (await readAgentConfig(agentId)).template ?? null;
}

/** The agent's instructions, or empty when it has none. */
export async function readAgentInstructions(agentId: string): Promise<string> {
  return (await readAgentConfig(agentId)).instructions ?? '';
}

/**
 * Set or clear the agent's instructions, leaving its other settings alone.
 *
 * An empty string clears them, which is a real state — the agent then has no
 * instructions of its own rather than instructions that happen to be blank.
 */
export async function setAgentInstructions(params: {
  agentId: string;
  instructions: string;
}): Promise<AgentConfigFile> {
  return updateAgentConfig(params.agentId, (config) => ({
    ...config,
    instructions: params.instructions,
  }));
}

/** Set the agent's non-instruction settings, leaving its instructions alone. */
export async function setAgentSettings(params: {
  agentId: string;
  settings: RepoAgentAttributes;
}): Promise<AgentConfigFile> {
  return updateAgentConfig(params.agentId, (config) => ({
    ...config,
    settings: params.settings,
  }));
}

/** Read, change, write — in one workspace session. */
async function updateAgentConfig(
  agentId: string,
  change: (config: AgentConfigFile) => AgentConfigFile
): Promise<AgentConfigFile> {
  const config = await withAgentWorkspace(agentId, async (agent, fs) => {
    const next = change(await readRequiredAgentConfig(agent, fs));
    await writeAgentConfigFile(fs, agent.name, next);
    return next;
  });

  await propagateToLaunch(agentId, config);
  return config;
}

/**
 * Carry a config change to what launches the agent's next session.
 *
 * A session the Console starts itself reads the file at that moment and needs
 * nothing here. An automatic session does not: it is started by the agent's
 * controller from a launch spec built earlier, with the config baked in, so the
 * controller is re-applied to rebuild that spec. Otherwise the next automatic
 * session would run on the previous instructions while the app showed the new
 * ones.
 *
 * The launch-profile providers also keep a copy on the agent row.
 *
 * Done for every write rather than by each caller, so a new way to change the
 * config cannot forget it.
 */
async function propagateToLaunch(agentId: string, config: AgentConfigFile): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  const behavior = getPlugin(agent.providerId).behavior;
  if (!behavior.repoAgents && behavior.mcp?.launchProfileFields) {
    // Re-applies the controller itself when it has to.
    await setAgentProviderConfig({
      agentId,
      config: providerConfigFromAttributes(agent.providerId, {
        ...config.settings,
        instructions: config.instructions ?? '',
      }),
    });
    return;
  }

  if (!(await listAutoSessionAgentIds()).includes(agentId)) return;
  await ensureRemoteWatcher(agentId);
}
