import type { McpServerSpec } from './adapter';

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
