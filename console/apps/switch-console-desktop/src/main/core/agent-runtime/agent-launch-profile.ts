import type {
  PluginFs,
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
} from '@switch-console/core/agents/plugins';
import {
  resolveLaunchProfileEnv,
  resolveLaunchProfileHome,
} from '@switch-console/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';

/**
 * The launch profile carrying a session's per-agent specialization (model /
 * effort / instructions), or null for a provider that takes those another way
 * (Claude, on argv) and for an agent that specializes nothing.
 *
 * It does not register the Switch MCP server — the connector plugins ship that
 * in their own bundled `.mcp.json`, so it is present for every session of that
 * host rather than only the ones Switch Console launches.
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
    values: params.specialization ?? {},
  });
}

/** What a launch surface needs to apply a profile: argv, and env to merge. */
export type PreparedLaunchProfile = {
  args: string[];
  env: Record<string, string>;
};

/**
 * Apply a launching session's per-agent specialization by writing its launch
 * profile files into `homeFs` (rooted at the agent's home dir) and returning the
 * argv and environment that load them. Both are empty when there is nothing to
 * write.
 *
 * `homeDir` is the absolute path `homeFs` is rooted at — the same directory,
 * named twice because the profile's files are addressed relative to it while its
 * env has to name one absolutely (see `LAUNCH_PROFILE_HOME_PLACEHOLDER`).
 *
 * Used by the local and SSH runtimes, which write at launch. Remote auto-sessions
 * instead bake the files into their launch spec (see {@link
 * resolveAgentLaunchProfile}) and the sidecar writes them.
 */
export async function prepareAgentLaunchProfile(
  plugin: ReturnType<typeof getPlugin>,
  params: {
    homeFs: PluginFs;
    homeDir: string;
    slug: string;
    workingDir: string;
    specialization?: SwitchLaunchSpecialization;
  }
): Promise<PreparedLaunchProfile> {
  const profile = resolveAgentLaunchProfile(plugin, params);
  if (!profile) return { args: [], env: {} };

  for (const file of profile.files) {
    await params.homeFs.write(
      file.relativePath,
      resolveLaunchProfileHome(file.content, params.homeDir)
    );
  }
  return { args: profile.args, env: resolveLaunchProfileEnv(profile.env, params.homeDir) };
}
