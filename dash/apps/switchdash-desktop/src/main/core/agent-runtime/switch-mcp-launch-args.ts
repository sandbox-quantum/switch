import type { getPlugin } from '@main/core/providers/plugin-registry';
import { switchMcpUrl } from '@shared/core/switch-rooms/switch-mcp-endpoint';

/** MCP server name the Switch tools are registered under. */
export const SWITCH_MCP_SERVER_NAME = 'switch';

/** Env var the agent reads the Switch bearer token from at request time. */
export const SWITCH_MCP_TOKEN_ENV_VAR = 'SWITCH_API_TOKEN';

/**
 * Launch arguments registering the Switch MCP server for this session, for
 * agents that must receive it on argv.
 *
 * Only the endpoint is passed. The token is named, not embedded: the agent reads
 * it from the injected `SWITCH_API_TOKEN` at request time, so a per-agent secret
 * never reaches a process listing or a config file.
 *
 * Returns nothing when the provider resolves MCP servers some other way (its
 * connector plugin expands env vars) or when the session has no Switch identity
 * — an agent with no credentials has no endpoint to point at.
 *
 * `apiEndpoint` may be `SWITCH_API_ENDPOINT_PLACEHOLDER` when precomputing a
 * launch spec for the on-VM watcher, which substitutes the real endpoint per
 * spawn.
 */
export function switchMcpLaunchArgs(
  plugin: ReturnType<typeof getPlugin>,
  apiEndpoint: string | undefined
): string[] {
  const buildArgs = plugin.behavior.mcp?.launchArgsForServer;
  if (!buildArgs) return [];

  const url = switchMcpUrl(apiEndpoint);
  if (url === null) return [];

  return buildArgs({
    name: SWITCH_MCP_SERVER_NAME,
    transport: 'http',
    url,
    bearer_token_env_var: SWITCH_MCP_TOKEN_ENV_VAR,
  });
}
