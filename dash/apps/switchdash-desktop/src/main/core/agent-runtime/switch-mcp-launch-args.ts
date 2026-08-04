import type {
  PluginFs,
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
} from '@switchdash/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';
import { switchAgentRuntimeCommand } from '@shared/core/switch-rooms/switch-agent-runtime';

/** MCP server name the Switch tools are registered under. */
export const SWITCH_MCP_SERVER_NAME = 'switch';

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
  params: { slug: string; hasSwitchIdentity: boolean; specialization?: SwitchLaunchSpecialization }
): SwitchLaunchProfile | null {
  const launchProfile = plugin.behavior.mcp?.launchProfile;
  if (!launchProfile) return null;

  return launchProfile({
    slug: params.slug,
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
    hasSwitchIdentity: boolean;
    specialization?: SwitchLaunchSpecialization;
  }
): Promise<string[]> {
  const profile = resolveSwitchLaunchProfile(plugin, params);
  if (!profile) return [];

  await removeLegacyHttpSwitchServer(plugin, params.homeFs);
  for (const file of profile.files) {
    await params.homeFs.write(file.relativePath, file.content);
  }
  return profile.args;
}

/**
 * Drop a `switch` server left in the base config by the pre-profile design,
 * which registered the runtime over HTTP.
 *
 * A profile does not replace a same-named server in the base config, it merges
 * with it — so the old entry's `url` meets this one's `command` and Codex
 * rejects the merged result outright, taking down every session started with
 * the profile rather than just its Switch tools. Removing the whole entry is
 * the only repair: one stripped of its transport is rejected in turn.
 *
 * Scoped to entries carrying a `url`, which is what the old registration wrote;
 * a `switch` server a user defined themselves over stdio is left alone.
 */
async function removeLegacyHttpSwitchServer(
  plugin: ReturnType<typeof getPlugin>,
  homeFs: PluginFs
): Promise<void> {
  const mcp = plugin.behavior.mcp;
  if (!mcp?.readServers || !mcp.removeServer) return;

  const legacy = (await mcp.readServers(homeFs)).find(
    (server) => server.name === SWITCH_MCP_SERVER_NAME && !!server.url && !server.command
  );
  if (!legacy) return;

  log.warn(
    `switch-mcp: removing the legacy HTTP '${SWITCH_MCP_SERVER_NAME}' server from the base config; ` +
      'it conflicts with the per-agent profile and blocks the whole config from loading'
  );
  await mcp.removeServer(homeFs, SWITCH_MCP_SERVER_NAME);
}
