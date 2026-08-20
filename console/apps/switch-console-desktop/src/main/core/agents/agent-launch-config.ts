import type { PluginFs, SwitchLaunchSpecialization } from '@switch-console/core/agents/plugins';
import { log } from '@main/lib/logger';
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

/**
 * The agent's stored configuration, without reconciling it against the
 * provider's generated file.
 *
 * For the paths that only need to know what to launch with — spawning a
 * session, building a remote launch spec, reporting sidecar diagnostics. Those
 * run in the background and on a timer, and the reconciling read writes files
 * as part of reading, which is not something a status poll should do.
 *
 * Returns an empty config when the agent has no file yet, and when the working
 * directory cannot be reached: an agent that has never been configured and one
 * whose host is down both mean "nothing to specialize with", and failing the
 * launch over a missing optional file would be worse than launching with the
 * provider's own defaults. The failure is logged rather than swallowed.
 */
export async function readAgentConfigForLaunch(agentId: string): Promise<AgentConfigFile> {
  try {
    return await withAgentWorkspace(
      agentId,
      async (agent, fs) => (await readAgentConfigFile(fs, agent.name)) ?? {}
    );
  } catch (error) {
    log.warn('Could not read agent config; launching with provider defaults', {
      event: 'agent_config_read_failed',
      agentId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
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
