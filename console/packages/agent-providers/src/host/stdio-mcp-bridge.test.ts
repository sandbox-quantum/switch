
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, it } from 'vitest';

it('forwards stdio MCP tool listing and calls to the HTTP MCP server', async () => {
  const token = 'test-bridge-token';

  const httpServer = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk));
    }

    const body = Buffer.concat(chunks).toString();

    if (!body.trim()) {
    res.writeHead(400).end();
    return;
    }

    const message = JSON.parse(body) as {
      id?: string | number;
      method: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };

    if (message.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    let result: unknown;

    if (message.method === 'initialize') {
      result = {
        protocolVersion: '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'test-switch-server', version: '1.0.0' },
      };
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'switch_echo',
            description: 'Echo a message',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      };
    } else if (message.method === 'tools/call') {
      result = {
        content: [
          {
            type: 'text',
            text: `MCP_BRIDGE_OK: ${String(message.params?.arguments?.message)}`,
          },
        ],
      };
    } else {
      res.writeHead(404).end();
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: message.id,
      result,
    }));
  });

  let client: Client | undefined;
  let stdioTransport: StdioClientTransport | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    const address = httpServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Could not determine MCP test server port.');
    }

    const bridgePath = fileURLToPath(
      new URL('../../dist/stdio-mcp-bridge.mjs', import.meta.url)
    );

    stdioTransport = new StdioClientTransport({
      command: process.execPath,
      args: [bridgePath],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        ),
        SWITCH_MCP_URL: `http://127.0.0.1:${address.port}/mcp`,
        SWITCH_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${token}`,
        }),
      },
    });

    client = new Client(
      { name: 'stdio-bridge-test-client', version: '1.0.0' },
      { capabilities: {} }
    );

    await client.connect(stdioTransport);

    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name)).toContain('switch_echo');

    const called = await client.callTool({
      name: 'switch_echo',
      arguments: { message: 'hello' },
    });

    expect(called.content).toEqual([
      { type: 'text', text: 'MCP_BRIDGE_OK: hello' },
    ]);
  } finally {
    await client?.close();
    await stdioTransport?.close();

    if (httpServer.listening) {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  }
});
