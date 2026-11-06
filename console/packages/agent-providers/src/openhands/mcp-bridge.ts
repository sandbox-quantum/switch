import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

const configuration = z.discriminatedUnion('transport', [
  z.object({
    transport: z.literal('http'),
    url: z.string().url(),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  z.object({
    transport: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()),
    env: z.record(z.string(), z.string()).optional(),
  }),
]);

/** OpenHands' tool base class reserves `kind`; keep the adaptation at its MCP boundary. */
export function createOpenHandsMcpBridge(client: Client): Server {
  const server = new Server(
    { name: 'switch-openhands-mcp', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );
  const argumentNames = new Map<string, string>();
  server.setRequestHandler(ListToolsRequestSchema, async (request) => {
    const result = await client.listTools(request.params);
    const tools = result.tools.map((tool) => {
      const properties = tool.inputSchema.properties;
      if (!properties || !Object.hasOwn(properties, 'kind')) {
        argumentNames.delete(tool.name);
        return tool;
      }
      let alias = 'switch_kind';
      while (Object.hasOwn(properties, alias)) alias += '_';
      argumentNames.set(tool.name, alias);
      const { kind, ...rest } = properties;
      return {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: { ...rest, [alias]: kind },
          ...(tool.inputSchema.required
            ? {
                required: tool.inputSchema.required.map((name) => (name === 'kind' ? alias : name)),
              }
            : {}),
        },
      };
    });
    return { ...result, tools };
  });
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = { ...request.params.arguments };
    const alias = argumentNames.get(request.params.name);
    if (alias && Object.hasOwn(args, alias)) {
      args.kind = args[alias];
      delete args[alias];
    }
    return await client.callTool({ ...request.params, arguments: args });
  });
  return server;
}

/** Invoked by the execution host bundle, with all connection details in its environment. */
export async function runOpenHandsMcpBridge(): Promise<void> {
  const spec = configuration.parse(JSON.parse(process.env.SWITCH_OPENHANDS_MCP ?? 'null'));
  const client = new Client({ name: 'switch-openhands-mcp', version: '1.0.0' });
  const transport =
    spec.transport === 'http'
      ? new StreamableHTTPClientTransport(new URL(spec.url), {
          requestInit: { headers: spec.headers },
        })
      : new StdioClientTransport({
          command: spec.command,
          args: spec.args,
          env: { ...getDefaultEnvironment(), ...spec.env },
        });
  await client.connect(transport);
  const server = createOpenHandsMcpBridge(client);
  const close = async () => {
    await server.close();
    await client.close();
  };
  process.stdin.once('end', () => void close());
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  await server.connect(new StdioServerTransport());
}
