import type { PluginFs } from '@switchdash/core/agents/plugins';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { log } from '@main/lib/logger';
import { SWITCH_MCP_SERVER_NAME } from './switch-mcp-launch-args';

/**
 * Refuse to launch when the agent's own config already defines a server under
 * the name switchdash is about to register on argv.
 *
 * `-c mcp_servers.<name>.<key>` merges into the config's table for that name
 * rather than replacing it. Verified against Codex 0.146.0: overriding `url` on
 * a name the config defines as a stdio server yields a table with both `command`
 * and `url`, and Codex then refuses to load its config *at all* — the session
 * exits immediately with a parse error switchdash never sees. Failing here turns
 * that into a legible message.
 *
 * `homeFs` is the agent's user-scope filesystem, or null when it cannot be read.
 * Null is a documented skip, not a pass: a remote agent's VM home is not mounted
 * here (`resolveWorkspaceFsFor` returns a `PluginFs` whose `exists` is always
 * false), so probing it would answer "no collision" for every host.
 */
export async function assertSwitchMcpNameFree(
  plugin: ReturnType<typeof getPlugin>,
  providerId: string,
  homeFs: PluginFs | null
): Promise<void> {
  const mcp = plugin.behavior.mcp;
  // Only providers that receive the server on argv can collide this way; for
  // everyone else an existing `switch` server is the normal, wanted state.
  if (!mcp?.launchArgsForServer) return;

  if (homeFs === null) {
    log.warn('switch-mcp: skipping the MCP name collision check — home scope not readable', {
      providerId,
      serverName: SWITCH_MCP_SERVER_NAME,
    });
    return;
  }

  const existing = await mcp.readServers(homeFs);
  if (!existing.some((server) => server.name === SWITCH_MCP_SERVER_NAME)) return;

  throw new Error(
    `Your ${providerId} config already defines an MCP server named "${SWITCH_MCP_SERVER_NAME}". ` +
      `switchdash registers the Switch server under that name on the command line, and ${providerId} ` +
      `merges the two into one entry it then refuses to load. Rename or remove the existing ` +
      `"${SWITCH_MCP_SERVER_NAME}" server and start the session again.`
  );
}
