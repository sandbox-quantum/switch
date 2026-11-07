import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { expect, it } from 'vitest';
import { createOpenHandsMcpBridge } from './mcp-bridge';

it.each(['host-daemon', 'shared-host-daemon'])(
  'reaches authenticated HTTP tools through the real %s stdio helper',
  async (bundle) => {
    let calls = 0;
    const http = createServer((request, response) => {
      if (request.headers.authorization !== 'Bearer fixture-only') {
        response.writeHead(401).end();
        return;
      }
      const source = new Server(
        { name: 'http-fixture', version: '1' },
        { capabilities: { tools: {} } }
      );
      source.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'echo',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      }));
      source.setRequestHandler(CallToolRequestSchema, async (message) => {
        calls++;
        return { content: [{ type: 'text', text: String(message.params.arguments?.text) }] };
      });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      void source
        .connect(transport)
        .then(() => transport.handleRequest(request, response))
        .catch(() => {
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      response.once('close', () => {
        void transport.close();
        void source.close();
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const caller = new Client({ name: 'real-stdio-caller', version: '1' });
    try {
      await caller.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            fileURLToPath(new URL(`../../dist/${bundle}.mjs`, import.meta.url)),
            '--openhands-mcp',
          ],
          env: {
            ...getDefaultEnvironment(),
            SWITCH_OPENHANDS_MCP: JSON.stringify({
              transport: 'http',
              url: `http://127.0.0.1:${address.port}/mcp`,
              headers: { Authorization: 'Bearer fixture-only' },
            }),
          },
          stderr: 'ignore',
        })
      );
      expect((await caller.listTools()).tools[0]?.name).toBe('echo');
      expect(
        await caller.callTool({ name: 'echo', arguments: { text: 'through-bridge' } })
      ).toMatchObject({ content: [{ text: 'through-bridge' }] });
      expect(calls).toBe(1);
    } finally {
      await caller.close();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  }
);

it('preserves tool schemas and reverses reserved argument aliases, including name collisions', async () => {
  const upstream = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  upstream.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'list_templates',
        inputSchema: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['agent'] },
            switch_kind: { type: 'boolean' },
          },
          required: ['kind'],
        },
      },
    ],
  }));
  let received: unknown;
  upstream.setRequestHandler(CallToolRequestSchema, async (request) => {
    received = request.params.arguments;
    return { content: [{ type: 'text', text: 'done' }] };
  });
  const remote = new Client({ name: 'bridge-upstream', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await upstream.connect(a);
  await remote.connect(b);
  const bridge = createOpenHandsMcpBridge(remote);
  const caller = new Client({ name: 'openhands-fixture', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  try {
    await bridge.connect(c);
    await caller.connect(d);
    const { tools } = await caller.listTools();
    expect(tools[0]?.inputSchema).toMatchObject({
      required: ['switch_kind_'],
      properties: { switch_kind_: { enum: ['agent'] }, switch_kind: { type: 'boolean' } },
    });
    expect(tools[0]?.inputSchema.properties).not.toHaveProperty('kind');
    await caller.callTool({
      name: 'list_templates',
      arguments: { switch_kind_: 'agent', switch_kind: true },
    });
    expect(received).toEqual({ kind: 'agent', switch_kind: true });
  } finally {
    await Promise.all([caller.close(), bridge.close(), remote.close(), upstream.close()]);
  }
});
