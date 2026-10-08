import type { PluginFs } from '@switch-console/core/agents/plugins';
import { type AgentLaunchSources, agentLaunchSources } from '@switch-console/plugins/agents';
import { getPlugin } from '@main/core/providers/plugin-registry';
import type { Agent } from '@shared/core/agents/agents';
import type { AgentConfigFile } from './agent-config-file';
import { readAgentConfigFile } from './agent-config-file';
import { getAgentLocation } from './agent-location';
import {
  agentStorageMigrationReady,
  isAgentUnmigrated,
  markAgentMigrated,
} from './agent-storage-migration-ready';
import { resolveWorkdirFsFor } from './agent-workdir-fs';
import { getAgentById } from './getAgentById';
import { importAgentConfig } from './import-agent-config';
import { agentConfigRelativePath } from './switch-settings-paths';

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
 * Every agent has a config file from the moment it is created, so one that has
 * none is broken, not blank. Treating it as empty would launch the agent with
 * no instructions, and the next save would write that emptiness back.
 */
export class AgentConfigMissingError extends Error {
  constructor(agentName: string) {
    super(
      `Agent ${agentName} has no settings file (${agentConfigRelativePath(agentName)}) in its working directory.`
    );
    this.name = 'AgentConfigMissingError';
  }
}

/**
 * The agent's config file, which must exist.
 *
 * Waits for the boot migration first, since that is what creates the file for
 * agents that predate it. An agent the migration could not reach at boot is
 * migrated here instead: its working directory is reachable now.
 */
export async function readRequiredAgentConfig(
  agent: Agent,
  fs: PluginFs
): Promise<AgentConfigFile> {
  await agentStorageMigrationReady();
  if (isAgentUnmigrated(agent.id)) {
    await importAgentConfig({
      workdirFs: fs,
      repoAgents: getPlugin(agent.providerId).behavior.repoAgents ?? null,
      name: agent.name,
      providerConfig: agent.providerConfig,
    });
    markAgentMigrated(agent.id);
  }
  const config = await readAgentConfigFile(fs, agent.name);
  if (config) return config;
  throw new AgentConfigMissingError(agent.name);
}

/**
 * What a session is launched with, from the agent's config file:
 * - `specialization`, the values a provider's launch profile is built from —
 *   the agent's settings plus its instructions, under the canonical key every
 *   provider renders;
 * - `definition`, for a provider that runs a session as a named agent, the
 *   definition it runs as.
 */
export type AgentLaunchConfig = AgentLaunchSources;

export async function agentLaunchConfig(agentId: string): Promise<AgentLaunchConfig> {
  return withAgentWorkdir(agentId, async (agent, fs) => {
    const config = await readRequiredAgentConfig(agent, fs);
    return agentLaunchSources({
      provider: agent.providerId,
      name: agent.name,
      description: config.description ?? '',
      settings: config.settings ?? {},
      instructions: config.instructions ?? '',
    });
  });
}

/** Run `run` against the agent's working directory, local or over SFTP. */
export async function withAgentWorkdir<T>(
  agentId: string,
  run: (agent: Agent, fs: PluginFs) => Promise<T>
): Promise<T> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error(`No agent with id ${agentId}`);

  const location = await getAgentLocation(agent);
  const workdir = await resolveWorkdirFsFor(location.sshHost, location.dir);
  try {
    return await run(agent, workdir.fs);
  } finally {
    workdir.close();
  }
}
