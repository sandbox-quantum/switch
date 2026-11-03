import { existsSync } from 'node:fs';
import type * as fs from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));
const servers: FakeAppServer[] = [];
/** Whether the fake CLI answers `session/new` or refuses it as unauthenticated. */
let signedIn = true;
vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'cline', name: 'Sign in with Cline' }],
    }));
    server.on('message', (message) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      if (signedIn) server.send({ id: message.id, result: { sessionId: 'native' } });
      else
        server.send({
          id: message.id,
          error: {
            code: -32000,
            message: 'Authentication required: Call authenticate before starting a session',
          },
        });
    });
    server.replyAlways('session/set_mode', () => ({}));
    servers.push(server);
    return server;
  },
}));
const { clineAcp, clineMcpSettings, createClineAdapter } = await import('./cline-adapter');
const unusedHandshake = async () => {
  throw new Error('checkSignIn must not call the given handshake');
};

beforeEach(() => {
  servers.length = 0;
  signedIn = true;
});

it('runs cline in ACP mode with no extra flags', () => {
  expect(clineAcp.launch({ binaryPath: '/usr/bin/cline', cwd: '/work', env: { X: '1' } })).toEqual({
    command: '/usr/bin/cline',
    args: ['--acp'],
    env: { X: '1' },
  });
});

it('pins every runtime mode to Act, since Cline enforces permissions instead of modes', () => {
  for (const mode of ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const)
    expect(clineAcp.sessionMode?.(mode)).toBe('act');
});

it('never sends authenticate at session start', async () => {
  const adapter = createClineAdapter();
  await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: {},
    connectorMcpServers: [],
  });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
  await adapter.stopSession('s');
});

it('writes stdio and streamable HTTP servers the way Cline reads them, filling envVars from the session', () => {
  expect(
    clineMcpSettings(
      {
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:4/mcp',
          headers: { Authorization: 'Bearer t' },
        },
        tools: { transport: 'stdio', command: 'node', args: ['s.js'], envVars: ['TOKEN'] },
      },
      { TOKEN: 'secret', OTHER: 'unused' }
    )
  ).toEqual({
    mcpServers: {
      switch: {
        transport: {
          type: 'streamableHttp',
          url: 'http://127.0.0.1:4/mcp',
          headers: { Authorization: 'Bearer t' },
        },
      },
      tools: {
        transport: { type: 'stdio', command: 'node', args: ['s.js'], env: { TOKEN: 'secret' } },
      },
    },
  });
});

it("writes the session's MCP servers to a settings file of its own, never ~/.cline, removed on cleanup", async () => {
  const delivery = await clineAcp.prepareMcpServers!(
    { switch: { transport: 'http', url: 'http://127.0.0.1:4/mcp' } },
    {}
  );
  const path = delivery.env.CLINE_MCP_SETTINGS_PATH!;
  expect(path).not.toContain('.cline');
  expect(delivery.env.CLINE_SESSION_BACKEND_MODE).toBe('local');
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
    mcpServers: {
      switch: { transport: { type: 'streamableHttp', url: 'http://127.0.0.1:4/mcp', headers: {} } },
    },
  });
  if (process.platform !== 'win32') {
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
  }
  await delivery.cleanup();
  expect(existsSync(dirname(path))).toBe(false);
});

it.each([
  ['echo__switch_echo: {"text":"PROBE_TOKEN_9012"}', 'echo'],
  ['google-workspace__gmail_search: {}', 'google-workspace'],
  ['composio_search_tools: {"queries":[{"use_case":"echo"}]}', undefined],
  ['run_commands: {"commands":["ls"]}', undefined],
  ['read_files: {"paths":["a__b.ts"]}', undefined],
  [undefined, undefined],
])('reads the MCP server from the tool title %s', (title, server) => {
  expect(clineAcp.mcpServerOf!({ toolCallId: 'c', title })).toBe(server);
});

it('shows spawn_agent calls as subagents', () => {
  expect(clineAcp.itemType!({ toolCallId: 'c', title: 'spawn_agent: Read the README' })).toBe(
    'subagent'
  );
  expect(clineAcp.itemType!({ toolCallId: 'c', title: 'run_commands: ls' })).toBeUndefined();
});

it('trusts a given API key without starting a process', async () => {
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: { CLINE_API_KEY: 'sk-test' },
    handshake: unusedHandshake,
  });
  expect(result.status).toBe('authenticated');
  expect(servers).toHaveLength(0);
});

it('reports signed in from session/new, without ever calling authenticate', async () => {
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: {},
    handshake: unusedHandshake,
  });
  expect(result).toEqual({ status: 'authenticated', message: 'Signed in.', models: [] });
  expect(servers.at(-1)!.received.some((m) => m.method === 'authenticate')).toBe(false);
});

it('hints to sign in when session/new refuses the session as unauthenticated', async () => {
  signedIn = false;
  const result = await clineAcp.checkSignIn!({
    binaryPath: '/usr/bin/cline',
    cwd: '/work',
    env: {},
    handshake: unusedHandshake,
  });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toBe(
    'Sign in on the execution machine with cline auth, or set CLINE_PROVIDER and CLINE_API_KEY there.'
  );
});
