import { homedir } from 'node:os';
import type { PluginFs } from '@switch-console/core/agents/plugins';
import { createRemoteHomePluginFs } from '@main/core/agent-runtime/impl/remote-home-plugin-fs';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';
import type { Agent } from '@shared/core/agents/agents';
import type { Location } from '@shared/core/locations/locations';
import { connectRemoteAgent } from './connect-remote-agent';

/**
 * Remove the per-agent launch profile a provider writes under the user's home
 * (Codex: `~/.codex/<name>.config.toml`), for the given `slug` — the agent's
 * current name on delete, its old name on rename.
 *
 * The profile lives in the home scope, not the working dir, so it is reached
 * through the same home filesystem that wrote it: local disk for a local agent,
 * and the exec-backed remote home for a remote one (the repo-dir `WorkspaceFs`
 * used elsewhere in teardown deliberately has no writable home for remote
 * agents). Best-effort and isolated: a filesystem or connection failure is
 * logged, not thrown, so the rest of the agent's teardown still runs — but it is
 * a real attempt, so a genuine failure is visible rather than a silent no-op.
 */
export async function removeAgentLaunchProfile(
  agent: Agent,
  location: Location,
  slug: string
): Promise<void> {
  const mcp = getPlugin(agent.providerId).behavior.mcp;
  const paths = mcp?.launchProfilePaths?.({ slug, workingDir: location.dir }) ?? [];
  if (paths.length === 0) return;

  let homeFs: PluginFs;
  try {
    homeFs =
      location.sshHost === null
        ? createPluginFs(homedir())
        : createRemoteHomePluginFs((await connectRemoteAgent(agent)).ctx);
  } catch (error) {
    log.warn('removeAgentLaunchProfile: could not reach the agent home to remove its profile', {
      agentId: agent.id,
      sshHost: location.sshHost,
      error: String(error),
    });
    return;
  }

  for (const path of paths) {
    await homeFs.delete(path).catch((error) => {
      log.warn('removeAgentLaunchProfile: failed to remove the per-agent launch profile', {
        agentId: agent.id,
        path,
        error: String(error),
      });
    });
  }
}
