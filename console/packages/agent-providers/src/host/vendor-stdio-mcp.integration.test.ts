import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Redactions } from './redaction';
import type { ServiceGrant } from './service-access';
import type { HostAsk } from './session-channel';
import { startVendorServers } from './vendor-mcp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const echoFixturePath = join(__dirname, '../testing/fixtures/echo-mcp-server.mjs');

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !isProcessAlive(pid);
}

describe('Supervised stdio MCP in startVendorServers', () => {
  it('launches, verifies env isolation, executes tools, and terminates child OS process upon revocation', async () => {
    // Set a private host secret to verify it is NOT leaked to the stdio child
    process.env.SWITCH_HOST_SECRET = 'parent-private-credential-leak-check';

    const grant: ServiceGrant = {
      service: 'echo-service',
      access: 'write',
      tool_mode: 'allow',
      tools: ['switch_echo', 'get_env'],
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

    // 1. Verify spec published on loopback HTTP gateway
    const spec = vendorServers.specs['echo-server'];
    expect(spec).toBeDefined();
    expect(spec.transport).toBe('http');
    expect(spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    expect(spec.headers?.Authorization).toMatch(/^Bearer [0-9a-f]{64}$/);

    // 2. Connect client to loopback HTTP endpoint
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    });
    await client.connect(transport);

    // 3. List tools via loopback gateway -> stdio server
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'switch_echo')).toBe(true);
    expect(tools.tools.some((t) => t.name === 'get_env')).toBe(true);

    // 4. Call tool via loopback gateway -> stdio server
    const result = await client.callTool({
      name: 'switch_echo',
      arguments: { text: 'Hello from Stdio E2E!' },
    });
    expect(result.content).toEqual([{ type: 'text', text: 'Hello from Stdio E2E!' }]);

    // 5. Verify catalog-loaded environment substitution ({token} -> secret-token-123)
    const envSubResult = await client.callTool({
      name: 'get_env',
      arguments: { name: 'TEST_VAR' },
    });
    expect(envSubResult.content).toEqual([{ type: 'text', text: 'secret-token-123' }]);

    // 6. Verify environment security: host secrets must NOT be inherited by child stdio process
    const hostSecretResult = await client.callTool({
      name: 'get_env',
      arguments: { name: 'SWITCH_HOST_SECRET' },
    });
    expect(hostSecretResult.content).toEqual([{ type: 'text', text: '' }]);

    // 7. Verify active child OS process exists
    const pids = vendorServers.getPids?.('echo-service') ?? [];
    expect(pids.length).toBe(1);
    const [childPid] = pids;
    expect(childPid).toBeGreaterThan(0);
    expect(isProcessAlive(childPid)).toBe(true);

    // 8. Revoke grant and verify actual OS process termination
    expect(vendorServers.revokeService).toBeDefined();
    await vendorServers.revokeService!('echo-service');

    const exited = await waitForProcessExit(childPid, 4000);
    expect(exited).toBe(true);
    expect(isProcessAlive(childPid)).toBe(false);

    // 9. Subsequent tool call fails deterministically because child was terminated
    const afterRevokeResult = await client.callTool({
      name: 'switch_echo',
      arguments: { text: 'After revocation' },
    });
    expect(afterRevokeResult.isError).toBe(true);
    expect(afterRevokeResult.content?.[0]?.text).toContain('Queue closed; transport shutting down');

    await client.close().catch(() => {});
  });

  it('completes grant-revocation chain through session push IPC event', async () => {
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
          env: null,
        },
      ],
      cli_tools: [],
    };

    const redactions = new Redactions();
    const vendorServers = await startVendorServers({
      grants: [grant],
      ask: async () => ({
        kind: 'token',
        token: 'test-token',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      redactions,
      listTimeoutMs: 5000,
      callTimeoutMs: 5000,
      fetch: globalThis.fetch,
    });
    closers.push(vendorServers.close);

    const spec = vendorServers.specs['echo-server'];
    const client = new Client({ name: 'test-agent', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(spec.url), {
      requestInit: { headers: spec.headers },
    });
    await client.connect(transport);

    // Execute one tool call to ensure child is up and active
    await client.callTool({ name: 'switch_echo', arguments: { text: 'ping' } });

    const [childPid] = vendorServers.getPids?.('echo-service') ?? [];
    expect(childPid).toBeGreaterThan(0);
    expect(isProcessAlive(childPid)).toBe(true);

    // Simulate parent push IPC event handler registration
    let ipcRevokeListener: ((service: string) => Promise<void>) | null = null;
    const mockChannel = {
      onRevokeGrant: (handler: (service: string) => Promise<void>) => {
        ipcRevokeListener = handler;
      },
    };

    // Wire handler as shared-host does
    mockChannel.onRevokeGrant(async (service) => {
      await vendorServers.revokeService?.(service);
    });

    // Fire simulated parent IPC message
    expect(ipcRevokeListener).not.toBeNull();
    await ipcRevokeListener!('echo-service');

    // Verify child process exited completely
    const exited = await waitForProcessExit(childPid, 4000);
    expect(exited).toBe(true);

    await client.close().catch(() => {});
  });
});
