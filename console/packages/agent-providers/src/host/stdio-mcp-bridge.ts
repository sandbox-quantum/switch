import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const url = process.env.SWITCH_MCP_URL;
const headersJson = process.env.SWITCH_MCP_HEADERS;

if (!url || !headersJson) {
  console.error('SWITCH_MCP_URL and SWITCH_MCP_HEADERS are required.');
  process.exit(1);
}

let headers: Record<string, string>;
try {
  headers = JSON.parse(headersJson) as Record<string, string>;
} catch {
  console.error('SWITCH_MCP_HEADERS must contain valid JSON.');
  process.exit(1);
}

const remote = new Client(
  { name: 'switch-stdio-bridge', version: '0.1.0' },
  { capabilities: {} }
);

const httpTransport = new StreamableHTTPClientTransport(new URL(url), {
  requestInit: { headers },
});

const local = new Server(
  { name: 'switch-stdio-bridge', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

const stdioTransport = new StdioServerTransport();
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await Promise.allSettled([
    local.close(),
    remote.close(),
    httpTransport.close(),
    stdioTransport.close(),
  ]);
}

async function main(): Promise<void> {
  await remote.connect(httpTransport);

  local.setRequestHandler(ListToolsRequestSchema, async () => remote.listTools());

  local.setRequestHandler(CallToolRequestSchema, async (request) =>
    remote.callTool({
      name: request.params.name,
      arguments: request.params.arguments ?? {},
    })
  );

  await local.connect(stdioTransport);
  console.error('Switch MCP stdio bridge connected.');
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

main().catch(async (error: unknown) => {
  console.error('Switch MCP stdio bridge failed:', error);
  await shutdown();
  process.exitCode = 1;
});
