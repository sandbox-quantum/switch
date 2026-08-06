import type {
  PluginFs,
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
} from '@switchdash/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';

/**
 * The launch profile carrying a session's per-agent specialization (model /
 * effort / instructions), or null for a provider that takes those another way
 * (Claude, on argv) and for an agent that specializes nothing.
 *
 * It does not register the Switch MCP server — the connector plugins ship that
 * in their own bundled `.mcp.json`, so it is present for every session of that
 * host rather than only the ones switchdash launches.
 *
 * Pure — no write — so the caller decides where the files land: a direct write
 * for local/SSH sessions, or a baked launch spec the VM sidecar writes for remote
 * auto-sessions. Nothing it produces is secret, so the same profile is safe to
 * bake and ship.
 */
export function resolveAgentLaunchProfile(
  plugin: ReturnType<typeof getPlugin>,
  params: {
    slug: string;
    workingDir: string;
    specialization?: SwitchLaunchSpecialization;
  }
): SwitchLaunchProfile | null {
  const launchProfile = plugin.behavior.mcp?.launchProfile;
  if (!launchProfile) return null;

  return launchProfile({
    slug: params.slug,
    workingDir: params.workingDir,
    ...params.specialization,
  });
}

/**
 * Apply a launching session's per-agent specialization by writing its launch
 * profile files into `homeFs` (rooted at the agent's home dir) and returning the
 * argv that loads them. Returns `[]` when there is nothing to write.
 *
 * Used by the local and SSH runtimes, which write at launch. Remote auto-sessions
 * instead bake the files into their launch spec (see {@link
 * resolveAgentLaunchProfile}) and the sidecar writes them.
 */
export async function prepareAgentLaunchProfile(
  plugin: ReturnType<typeof getPlugin>,
  params: {
    homeFs: PluginFs;
    slug: string;
    workingDir: string;
    specialization?: SwitchLaunchSpecialization;
  }
): Promise<string[]> {
  const profile = resolveAgentLaunchProfile(plugin, params);
  if (!profile) return [];

  for (const file of profile.files) {
    await params.homeFs.write(file.relativePath, file.content);
  }
  return profile.args;
}
