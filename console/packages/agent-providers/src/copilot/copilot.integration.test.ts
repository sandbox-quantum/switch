import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServerSpec } from '../adapter';
import { describeConformance, EventRecorder } from '../testing/index';
import { copilotAcp, createCopilotAdapter } from './copilot-adapter';

// Copilot 1.0.107 rejects client-provided stdio MCP servers. Switch serves its tools over HTTP.
const mcpServers: Record<string, McpServerSpec> = {};
let echoCalls = 0;
const http = createServer(async (request, response) => {
  const server = new McpServer({ name: 'switch-echo', version: '1.0.0' });
  server.registerTool('switch_echo', { inputSchema: { text: z.string() } }, async ({ text }) => {
    echoCalls++;
    return { content: [{ type: 'text', text }] };
  });
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.on('close', () => void server.close());
  await server.connect(transport);
  await transport.handleRequest(request, response);
});
beforeAll(async () => {
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('Echo MCP server did not bind');
  mcpServers.echo = { transport: 'http', url: `http://127.0.0.1:${address.port}/mcp` };
});
afterAll(async () => {
  http.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    http.close((error) => (error ? reject(error) : resolve()))
  );
});

const installed = spawnSync('copilot', ['--version'], { encoding: 'utf8' }).status === 0;
const env = Object.fromEntries(
  [
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'TMPDIR',
    'LANG',
    'TERM',
    ...(copilotAcp.inheritEnv ?? []),
  ].flatMap((key) => {
    const value = process.env[key];
    return value === undefined ? [] : [[key, value]];
  })
);
describeConformance('copilot', {
  createAdapter: async () => createCopilotAdapter(),
  unavailableReason: async () => (installed ? null : 'the copilot binary is not on PATH'),
  mcpServers,
  skip: {
    'user-input': 'Copilot 1.0.107 does not expose a structured user-input request over ACP.',
  },
  env,
});

it.skipIf(!installed)(
  'requires approval for connector MCP tools and honors a refusal',
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'copilot-connector-'));
    const adapter = createCopilotAdapter();
    const recorder = new EventRecorder(adapter);
    const before = echoCalls;
    try {
      await adapter.startSession({
        sessionId: 'connector',
        cwd,
        env,
        runtimeMode: 'approval-required',
        mcpServers: { connector: mcpServers.echo! },
        connectorMcpServers: ['connector'],
      });
      await adapter.sendTurn({
        sessionId: 'connector',
        turnId: 'connector-turn',
        text: 'Call switch_echo from the connector MCP server with CONNECTOR_CHECK. If denied, stop and reply denied. Do not retry or use other tools.',
      });
      const request = await recorder.waitFor('request.opened', () => true, 30_000);
      expect(echoCalls).toBe(before);
      await adapter.respondToRequest('connector', request.requestId, 'decline');
      await recorder.waitFor('turn.completed', () => true, 30_000);
      expect(echoCalls).toBe(before);
    } finally {
      await adapter.stopAll();
      recorder.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  },
  60_000
);
