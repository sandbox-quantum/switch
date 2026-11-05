import type { McpServerSpec, StdioMcpServerSpec } from '../adapter';

/**
 * Where a relay (`host/mcp-relay.ts`) reads the server it relays to, kept out
 * of its arguments, which anyone on the machine can read.
 */
export const MCP_RELAY_URL_ENV = 'SWITCH_MCP_RELAY_URL';
export const MCP_RELAY_HEADERS_ENV = 'SWITCH_MCP_RELAY_HEADERS';
/** The tool arguments a relay offers under another name, as a JSON list. */
export const MCP_RELAY_RENAMED_ENV = 'SWITCH_MCP_RELAY_RENAMED';

/**
 * `servers` with each HTTP server replaced by `relay`, a stdio server that
 * relays to it, for an agent that takes MCP over stdio only. The relay offers
 * the tool arguments named in `renamed` under other names.
 */
export function relayHttpMcp(
  agent: string,
  servers: Record<string, McpServerSpec>,
  relay: StdioMcpServerSpec | undefined,
  renamed: readonly string[] = []
): Record<string, McpServerSpec> {
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      if (server.transport === 'stdio') return [name, server];
      if (!relay)
        throw new Error(
          `${agent} takes MCP servers over stdio only, and this host cannot relay ${name} to it.`
        );
      return [
        name,
        {
          ...relay,
          env: {
            ...relay.env,
            [MCP_RELAY_URL_ENV]: server.url,
            [MCP_RELAY_HEADERS_ENV]: JSON.stringify(server.headers ?? {}),
            ...(renamed.length > 0 ? { [MCP_RELAY_RENAMED_ENV]: JSON.stringify(renamed) } : {}),
          },
        },
      ];
    })
  );
}

/**
 * Refuse to start an ACP session whose HTTP MCP servers the agent cannot
 * reach.
 *
 * An ACP agent says in `initialize` whether it accepts MCP servers over HTTP
 * (`agentCapabilities.mcpCapabilities.http`). The Switch tools are served that
 * way, so an agent that does not declare it would start a session with no
 * Switch tools and nothing to say why. `http` is what the agent declared.
 */
export function requireHttpMcp(
  agent: string,
  servers: Record<string, McpServerSpec>,
  http: boolean | undefined
): void {
  const over = Object.entries(servers)
    .filter(([, spec]) => spec.transport === 'http')
    .map(([name]) => name);
  if (over.length === 0 || http === true) return;
  throw new Error(
    `${agent} does not declare MCP over HTTP (agentCapabilities.mcpCapabilities.http), and the MCP server${over.length > 1 ? 's' : ''} ${over.join(', ')} ${over.length > 1 ? 'are' : 'is'} only reachable that way. Update ${agent}; the session is not started without its tools.`
  );
}

/**
 * The session's MCP servers in ACP's `session/new` shape. A stdio server's
 * `envVars` are filled from the session environment, under its explicit `env`.
 */
export function acpMcpServers(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>
): Array<Record<string, unknown>> {
  return Object.entries(servers).map(([name, server]) =>
    server.transport === 'stdio'
      ? {
          name,
          command: server.command,
          args: server.args,
          env: Object.entries({
            ...Object.fromEntries(
              (server.envVars ?? [])
                .filter((key) => env[key] !== undefined)
                .map((key) => [key, env[key]])
            ),
            ...server.env,
          }).map(([name, value]) => ({ name, value })),
        }
      : {
          name,
          type: 'http',
          url: server.url,
          headers: Object.entries(server.headers ?? {}).map(([name, value]) => ({ name, value })),
        }
  );
}
