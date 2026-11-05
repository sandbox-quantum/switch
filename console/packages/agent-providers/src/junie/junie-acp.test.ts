import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';

const servers: FakeAppServer[] = [];
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ authMethods: [{ id: 'jetbrains-account' }] }));
    server.replyAlways('session/new', () => ({ sessionId: 'native' }));
    servers.push(server);
    return server;
  },
}));
const { checkAcpSignIn } = await import('../acp/acp-adapter');
const { createJunieAdapter, junieAcp } = await import('./junie-acp');
const adapters: ReturnType<typeof createJunieAdapter>[] = [];
let cwd = '';

beforeEach(async () => {
  servers.length = 0;
  cwd = await mkdtemp(join(tmpdir(), 'junie-unit-'));
});
afterEach(async () => {
  await Promise.allSettled(adapters.splice(0).map((adapter) => adapter.stopAll()));
  await rm(cwd, { recursive: true, force: true });
});

it('does not mistake an auth method or a configured key for validated authentication', async () => {
  const result = await checkAcpSignIn(junieAcp, {
    binaryPath: 'junie',
    cwd,
    env: {
      JUNIE_API_KEY: 'configured-but-unverified',
      JUNIE_OPENROUTER_API_KEY: 'configured-but-unverified',
    },
  });
  expect(result.status).toBe('unknown');
  expect(servers[0]!.received.map((message) => message.method)).toEqual(['initialize']);
});

it('routes captured Junie MCP permissions only to session-registered, non-connector servers', async () => {
  const adapter = createJunieAdapter();
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  await adapter.startSession({
    sessionId: 's',
    cwd,
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {
      echo: { transport: 'stdio', command: 'node', args: ['echo.js'] },
      connector: { transport: 'stdio', command: 'node', args: ['connector.js'] },
    },
    connectorMcpServers: ['connector'],
  });
  await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'go' });
  const server = servers.at(-1)!;
  for (const [id, title, marked] of [
    [70, 'echo/switch_echo', true],
    [71, 'elsewhere/switch_echo', true],
    [72, 'echo/unmarked_tool', false],
    [73, 'connector/tool', true],
  ] as const) {
    server.send({
      id,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: `call-${id}`, title, _meta: { is_mcp_tool_call: marked } },
        options: [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }],
      },
    });
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(server.received.find((message) => message.id === 70)?.result).toEqual({
    outcome: { outcome: 'selected', optionId: 'once' },
  });
  expect(events.filter((event) => event.type === 'request.opened')).toHaveLength(3);
});
