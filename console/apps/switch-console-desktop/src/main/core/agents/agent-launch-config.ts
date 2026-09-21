import type { PluginFs, SwitchLaunchSpecialization } from '@switch-console/core/agents/plugins';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentConfigFile } from './agent-config-file';
import { readAgentConfigFile } from './agent-config-file';
import { getAgentLocation } from './agent-location';
import { resolveWorkspaceFsFor } from './agent-workspace-fs';
import { getAgentById } from './getAgentById';

/**
 * Reading an agent's configuration in order to launch it (CHOO-2228).
 *
 * Split from the read/write module deliberately. Saving configuration has to
 * reach a remote agent's launch spec, which means depending on the sidecar
 * machinery — and that machinery in turn wants to know what to launch with, so
 * keeping both in one module makes a cycle. The launch side needs none of it:
 * it only reads a file.
 */

/** Read launch settings from the execution host; transport failures must stop launch. */
export async function readAgentConfigForLaunch(agentId: string): Promise<AgentConfigFile> {
  return withAgentWorkspace(
    agentId,
    async (agent, fs) => (await readAgentConfigFile(fs, agent.name)) ?? {}
  );
}

/**
 * The values a provider's launch profile is built from: the agent's settings
 * plus its instructions, under the canonical key every provider renders.
 */
export async function agentLaunchSpecialization(
  agentId: string
): Promise<SwitchLaunchSpecialization | undefined> {
  const config = await readAgentConfigForLaunch(agentId);
  const specialization: SwitchLaunchSpecialization = {};

  for (const [key, value] of Object.entries(config.settings ?? {})) {
    if (value === null || value === undefined) continue;
    const text = Array.isArray(value) ? value.join(',') : String(value);
    if (text.trim() === '') continue;
    specialization[key] = text;
  }
  if (config.instructions) specialization.instructions = config.instructions;

  return Object.keys(specialization).length > 0 ? specialization : undefined;
}

/** Run `run` against the agent's working directory, local or over SFTP. */
export async function withAgentWorkspace<T>(
  agentId: string,
  run: (agent: Agent, fs: PluginFs) => Promise<T>
): Promise<T> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  const location = await getAgentLocation(agent);
  const workspace = await resolveWorkspaceFsFor(location.sshHost, location.dir);
  try {
    return await run(agent, workspace.fs);
  } finally {
    workspace.close();
  }
}
