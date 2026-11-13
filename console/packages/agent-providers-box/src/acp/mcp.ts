import type { McpServerSpec } from '../adapter';

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
