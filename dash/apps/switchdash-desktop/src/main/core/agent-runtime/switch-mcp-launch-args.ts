import type { PluginFs, SwitchLaunchProfile } from '@switchdash/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { switchAgentRuntimeCommand } from '@shared/core/switch-rooms/switch-agent-runtime';

/** MCP server name the Switch tools are registered under. */
export const SWITCH_MCP_SERVER_NAME = 'switch';

/**
 * The launch profile that registers the Switch MCP server for a session, or null
 * when the provider resolves the server another way (Claude's bundled `.mcp.json`)
 * or the session has no Switch identity.
 *
 * Pure — no write — so the caller decides where the profile lands: a direct write
 * for local/SSH sessions, or a baked launch spec the VM sidecar writes for remote
 * auto-sessions. The runtime it registers is static and secret-free; it reads its
 * `SWITCH_*` credentials from the session env it inherits.
 */
export function resolveSwitchLaunchProfile(
  plugin: ReturnType<typeof getPlugin>,
  params: { slug: string; hasSwitchIdentity: boolean }
): SwitchLaunchProfile | null {
  const launchProfile = plugin.behavior.mcp?.launchProfile;
  if (!launchProfile) return null;

  return launchProfile({
    slug: params.slug,
    switchServer: params.hasSwitchIdentity ? switchAgentRuntimeCommand() : null,
  });
}

/**
 * Register the Switch MCP server for a launching session by writing its launch
 * profile into `homeFs` (rooted at the agent's home dir) and returning the argv
 * that loads it. Returns `[]` when there is nothing to register.
 *
 * Used by the local and SSH runtimes, which write at launch. Remote auto-sessions
 * instead bake the profile into their launch spec (see {@link
 * resolveSwitchLaunchProfile}) and the sidecar writes it.
 */
export async function prepareSwitchMcpLaunch(
  plugin: ReturnType<typeof getPlugin>,
  params: { homeFs: PluginFs; slug: string; hasSwitchIdentity: boolean }
): Promise<string[]> {
  const profile = resolveSwitchLaunchProfile(plugin, params);
  if (!profile) return [];

  await params.homeFs.write(profile.relativePath, profile.content);
  return profile.args;
}
