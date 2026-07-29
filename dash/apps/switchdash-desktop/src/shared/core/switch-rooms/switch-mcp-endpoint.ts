/**
 * The agent-bridge endpoint an agent's Switch MCP server is addressed by.
 *
 * Lives in `shared` because both halves of the remote path need it: the main
 * process bakes a placeholder into a precomputed launch spec, and the on-VM
 * sidecar — which bundles free of Electron and the database — substitutes the
 * real endpoint into it at spawn time. Normalising in one place keeps the two
 * from disagreeing about the trailing slash.
 */

/** Path appended to the agent-bridge endpoint to reach its MCP surface. */
export const SWITCH_MCP_PATH_SUFFIX = '/mcp/';

/**
 * Argv token switchdash emits in place of an agent's Switch API endpoint.
 *
 * Unlike the session id and prompt tokens this is substituted as a *substring*:
 * the endpoint is embedded inside a provider-specific argument (Codex renders
 * `mcp_servers.switch.url="<endpoint>/mcp/"`) rather than occupying an argv
 * element of its own.
 */
export const SWITCH_API_ENDPOINT_PLACEHOLDER = '__SWITCHDASH_SWITCH_API_ENDPOINT__';

/**
 * Strip trailing slashes so appending {@link SWITCH_MCP_PATH_SUFFIX} yields
 * exactly one. Returns null when there is no usable endpoint — an agent with no
 * Switch identity has nothing to point at, and a half-formed URL is worse than
 * no MCP server at all.
 */
export function normalizeSwitchApiEndpoint(endpoint: string | undefined): string | null {
  const trimmed = endpoint?.trim().replace(/\/+$/, '');
  return trimmed ? trimmed : null;
}

/** The MCP URL for an agent-bridge endpoint, or null when there is no endpoint. */
export function switchMcpUrl(endpoint: string | undefined): string | null {
  const base = normalizeSwitchApiEndpoint(endpoint);
  return base === null ? null : `${base}${SWITCH_MCP_PATH_SUFFIX}`;
}
