import { fileURLToPath } from 'node:url';
import type { StdioMcpServerSpec } from '../../adapter';

/** The fixture MCP server, resolved so it works from source and from dist. */
export function echoMcpServerSpec(): StdioMcpServerSpec {
  const path = fileURLToPath(new URL('./echo-mcp-server.mjs', import.meta.url));
  return { transport: 'stdio', command: process.execPath, args: [path] };
}
