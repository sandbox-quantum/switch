import type { AcpMcpBridge } from '../acp/hooks';
import type { McpServerSpec } from '../adapter';
import { OPENHANDS_MCP_SPEC } from './mcp-bridge';

/**
 * OpenHands 1.16 cannot consume ACP HTTP header arrays and its SDK reserves
 * `kind` in MCP input schemas. Adapt each server through the host-owned stdio
 * bridge. The spec may contain credentials: pass it only in the child env.
 */
export function prepareOpenHandsMcpServers(
  servers: Record<string, McpServerSpec>,
  env: Record<string, string>,
  bridge: AcpMcpBridge | undefined
): Record<string, McpServerSpec> {
  if (!Object.keys(servers).length) return {};
  if (!bridge) throw new Error('OpenHands MCP requires the Switch host MCP bridge.');
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const spec =
        server.transport === 'http'
          ? { transport: 'http', url: server.url, headers: server.headers ?? {} }
          : {
              transport: 'stdio',
              command: server.command,
              args: server.args,
              env: {
                ...Object.fromEntries(
                  (server.envVars ?? [])
                    .filter((key) => env[key] !== undefined)
                    .map((key) => [key, env[key]])
                ),
                ...server.env,
              },
            };
      const configuration = JSON.stringify(spec);
      if (Buffer.byteLength(configuration, 'utf8') > 64 * 1024)
        throw new Error('OpenHands MCP bridge configuration is too large.');
      return [
        name,
        {
          transport: 'stdio' as const,
          command: bridge.command,
          args: [...bridge.args, 'openhands'],
          env: { ELECTRON_RUN_AS_NODE: '1', [OPENHANDS_MCP_SPEC]: configuration },
        },
      ];
    })
  );
}
