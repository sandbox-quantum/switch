import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Redactions } from './redaction';
import type { ServiceGrant } from './service-access';
import type { HostAsk } from './session-channel';
import { startVendorServers, type VendorServers } from './vendor-mcp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const echoFixturePath = join(__dirname, '../testing/fixtures/echo-mcp-server.mjs');

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe('Supervised stdio MCP in startVendorServers', () => {
  it('launches, connects, discovers tools, executes tool, and handles revocation on stdio server', async () => {
    const grant: ServiceGrant = {
      service: 'echo-service',
      access: 'write',
      tool_mode: 'allow',
      tools: ['switch_echo'],
      resources: {},
      skill: null,
      mcp_servers: [
        {
          transport: 'stdio',
          name: 'echo-server',
          command: process.execPath,
          args: [echoFixturePath],
          env: { TEST_VAR: '{token}' },
        },
      ],
      cli_tools: [],
    };

    const redactions = new Redactions();
    const vendorServers = await startVendorServers({
      grants: [grant],
      ask: async (ask: HostAsk) => {
        if (ask.type === 'service-token') {
          return {
            kind: 'token',
            token: 'secret-token-123',
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          };
        }
        throw new Error(`Unexpected ask: ${JSON.stringify(ask)}`);
      },
      redactions,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
      fetch: globalThis.fetch,
    });
    closers.push(vendorServers.close);

    // 1. Verify spec published on loopback HTTP
    const spec = vendorServers.specs['echo-server'];
    expect(spec).toBeDefined();
    expect(spec.transport).toBe('http');
    expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(spec.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);

    // 2. Connect client to loopback HTTP endpoint (as an agent would)
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    });
    await client.connect(transport);

    // 3. List tools via loopback gateway -> stdio server
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'switch_echo')).toBe(true);

    // 4. Call tool via loopback gateway -> stdio server
    const result = await client.callTool({
      name: 'switch_echo',
      arguments: { text: 'Hello from Stdio E2E!' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from Stdio E2E!' }]);

    // 5. Test push revocation
    expect(vendorServers.revokeService).toBeDefined();
    await vendorServers.revokeService!('echo-service');

    // Subsequent tool call returns an error tool result because child process and queue were terminated
    const afterRevokeResult = await client.callTool({
      name: 'switch_echo',
      arguments: { text: 'After revocation' },
    });
    expect(afterRevokeResult.isError).toBe(true);
    expect(afterRevokeResult.content?.[0]?.text).toContain('Queue closed; transport shutting down');

    await client.close().catch(() => {});
  });
});
