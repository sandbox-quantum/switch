import type {
  PluginFs,
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
} from '@switchdash/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { switchAgentRuntimeCommand } from '@shared/core/switch-rooms/switch-agent-runtime';

/**
 * The launch profile that registers the Switch MCP server for a session and
 * folds in any per-agent specialization (model / effort / instructions), or null
 * when the provider resolves the server another way (Claude's bundled `.mcp.json`)
 * and there is nothing to specialize.
 *
 * Pure — no write — so the caller decides where the files land: a direct write
 * for local/SSH sessions, or a baked launch spec the VM sidecar writes for remote
 * auto-sessions. The runtime it registers is static and secret-free: the profile
 * names the variables the provider must route into the server's process rather
 * than carrying their values, so the same profile is safe to bake and ship.
 */
export function resolveSwitchLaunchProfile(
  plugin: ReturnType<typeof getPlugin>,
  params: {
    slug: string;
    workingDir: string;
    hasSwitchIdentity: boolean;
    specialization?: SwitchLaunchSpecialization;
  }
): SwitchLaunchProfile | null {
  const launchProfile = plugin.behavior.mcp?.launchProfile;
  if (!launchProfile) return null;

  return launchProfile({
    slug: params.slug,
    workingDir: params.workingDir,
    switchServer: params.hasSwitchIdentity ? switchAgentRuntimeCommand() : null,
    ...params.specialization,
  });
}

/**
 * Register the Switch MCP server for a launching session by writing its launch
 * profile files into `homeFs` (rooted at the agent's home dir) and returning the
 * argv that loads them. Returns `[]` when there is nothing to write.
 *
 * Used by the local and SSH runtimes, which write at launch. Remote auto-sessions
 * instead bake the files into their launch spec (see {@link
 * resolveSwitchLaunchProfile}) and the sidecar writes them.
 */
export async function prepareSwitchMcpLaunch(
  plugin: ReturnType<typeof getPlugin>,
  params: {
    homeFs: PluginFs;
    slug: string;
    workingDir: string;
    hasSwitchIdentity: boolean;
    specialization?: SwitchLaunchSpecialization;
  }
): Promise<string[]> {
  const profile = resolveSwitchLaunchProfile(plugin, params);
  if (!profile) return [];

  for (const file of profile.files) {
    await params.homeFs.write(file.relativePath, file.content);
  }
  return profile.args;
}
