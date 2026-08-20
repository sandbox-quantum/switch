import type { PluginFs, RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { providerConfigFromAttributes } from '@shared/core/agents/agent-provider-config';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentConfigFile } from './agent-config-file';
import { writeAgentConfigFile } from './agent-config-file';
import { syncAgentConfig } from './agent-config-sync';
import { withAgentWorkspace } from './agent-launch-config';
import { getAgentById } from './getAgentById';
import { setAgentProviderConfig } from './setAgentProviderConfig';

/**
 * An agent's configuration, read and written where it actually lives: the
 * committed config file in its working directory (CHOO-2228).
 *
 * Every caller goes through here rather than touching the file, so the
 * reconciliation with the provider's own generated file happens on every read
 * — which is what makes a hand-edited Claude Code subagent definition show up
 * in the app rather than being quietly replaced the next time anything saves.
 *
 * The working directory is where the agent runs, so the file is reachable
 * whenever launching is possible, including over SFTP for a remote agent.
 */

/**
 * The agent's current configuration, reconciled with its provider definition.
 *
 * Reading has a side effect by design: if the definition was edited by hand the
 * edits are adopted into the config, and if the config moved on the definition
 * is regenerated. Doing this on read is what keeps the app from showing a value
 * that is not what the agent will actually launch with.
 */
export async function readAgentConfig(agentId: string): Promise<AgentConfigFile> {
  return withAgentWorkspace(agentId, (agent, fs) => reconcile(agent, fs));
}

/**
 * Replace the agent's configuration and regenerate whatever its provider reads.
 *
 * Write-then-generate, in that order: the config file is the record of what the
 * user chose, and the provider's file is derived from it. A failure part-way
 * leaves the choice recorded and the generated file stale, which the next read
 * repairs — the other order would lose the choice.
 */
export async function writeAgentConfig(params: {
  agentId: string;
  config: AgentConfigFile;
}): Promise<AgentConfigFile> {
  return withAgentWorkspace(params.agentId, async (agent, fs) => {
    await writeAgentConfigFile(fs, agent.name, params.config);
    return reconcile(agent, fs);
  });
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

/**
 * Read, change, write — in one workspace session.
 *
 * Not read-then-write through the public helpers: over SSH that opens the
 * working directory twice, and it would reconcile twice for one edit.
 */
async function updateAgentConfig(
  agentId: string,
  change: (config: AgentConfigFile) => AgentConfigFile
): Promise<AgentConfigFile> {
  const config = await withAgentWorkspace(agentId, async (agent, fs) => {
    const current = await reconcile(agent, fs);
    await writeAgentConfigFile(fs, agent.name, change(current));
    return reconcile(agent, fs);
  });

  await propagateToLaunchProfile(agentId, config);
  return config;
}

/**
 * Carry a config change into the launch profile, for the providers that read
 * one.
 *
 * A provider with repository definitions (Claude Code) needs nothing here: its
 * CLI reads the definition file itself at every spawn, and the write above
 * already put it in place — on a remote host too, over SFTP.
 *
 * The others do. Their settings reach a session as a generated profile file,
 * and on a remote host that file is baked into the launch spec the on-VM
 * sidecar holds. Writing the config file alone would leave that spec stale, so
 * an auto-started session would keep running on the previous instructions while
 * the app showed the new ones. This is what rewrites it.
 *
 * Done for every write rather than by each caller, so a new way to change the
 * config cannot forget it and quietly reintroduce that gap.
 */
async function propagateToLaunchProfile(agentId: string, config: AgentConfigFile): Promise<void> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  const behavior = getPlugin(agent.providerId).behavior;
  if (behavior.repoAgents || !behavior.mcp?.launchProfileFields) return;

  await setAgentProviderConfig({
    agentId,
    config: providerConfigFromAttributes(agent.providerId, {
      ...config.settings,
      instructions: config.instructions ?? '',
    }),
  });
}

/**
 * Bring the config file and the provider's generated file into agreement.
 *
 * The description comes from the definition rather than from the agent's Switch
 * server: it is the server's to own, and this must not blank it when the server
 * is unreachable. It round-trips through the definition anyway, so reading it
 * from there is both correct and one fewer thing that can fail at launch.
 */
async function reconcile(agent: Agent, fs: PluginFs): Promise<AgentConfigFile> {
  const repoAgents = getPlugin(agent.providerId).behavior.repoAgents ?? null;
  const existing = repoAgents ? await repoAgents.readDefinition(fs, agent.name) : null;
  const description = typeof existing?.description === 'string' ? existing.description : '';

  const { config } = await syncAgentConfig({
    workspaceFs: fs,
    repoAgents,
    name: agent.name,
    description,
  });
  return config;
}
