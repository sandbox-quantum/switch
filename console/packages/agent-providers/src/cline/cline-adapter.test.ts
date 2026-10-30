import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import { FakeAppServer, type FakeJsonRpcMessage } from '../codex/fake-app-server';

/** How the fake Cline answers `session/new`: a session, or Cline's refusal when signed out. */
let signedIn = true;
const spawned: Array<{ args: string[]; env: Record<string, string> }> = [];
vi.mock('node:child_process', () => ({
  spawn: (_command: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ args, env: options.env });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({ agentCapabilities: { loadSession: true } }));
    server.on('message', (message: FakeJsonRpcMessage) => {
      if (message.method !== 'session/new' || message.id === undefined) return;
      server.send(
        signedIn
          ? { id: message.id, result: { sessionId: 'native' } }
          : {
              id: message.id,
              error: {
                code: -32000,
                message: 'Authentication required: Call authenticate before starting a session',
              },
            }
      );
    });
    return server;
  },
}));
const { clineAcp, clineLaunch, clineMcpSettings } = await import('./cline-adapter');

beforeEach(() => {
  signedIn = true;
  spawned.length = 0;
});

const handshake = () => Promise.reject(new Error('not used'));
const check = (env: Record<string, string>) =>
  clineAcp.checkSignIn!({ binaryPath: 'cline', cwd: process.cwd(), env, handshake });

it('writes stdio and HTTP servers the way Cline reads them, filling envVars from the session', () => {
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

it('launches ACP mode on the local backend with a settings file of its own, removed on release', async () => {
  const launch = await clineLaunch({
    binaryPath: '/bin/cline',
    cwd: '/work',
    env: { PATH: '/bin' },
    mcpServers: { switch: { transport: 'http', url: 'http://127.0.0.1:4/mcp' } },
  });
  const settings = launch.env.CLINE_MCP_SETTINGS_PATH!;
  expect(launch).toMatchObject({
    command: '/bin/cline',
    args: ['--acp', '--auto-approve', 'false'],
    env: { PATH: '/bin', CLINE_SESSION_BACKEND_MODE: 'local' },
    mcpServersInLaunch: true,
  });
  expect(JSON.parse(await readFile(settings, 'utf8')).mcpServers.switch.transport.url).toBe(
    'http://127.0.0.1:4/mcp'
  );
  if (process.platform !== 'win32') expect((await stat(settings)).mode & 0o777).toBe(0o600);
  await launch.release!();
  expect(existsSync(dirname(settings))).toBe(false);
});

it.each([
  ['switch__send_message: {"text":"hi"}', 'switch'],
  ['google-workspace__gmail_search: {}', 'google-workspace'],
  ['trello__trelloSearch', 'trello'],
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

it('takes an API key in the environment as a sign-in without starting Cline', async () => {
  expect(await check({ CLINE_API_KEY: 'k', CLINE_PROVIDER: 'gemini' })).toMatchObject({
    status: 'authenticated',
    message: 'Signs in with the API key it was given, on gemini.',
  });
  expect(spawned).toEqual([]);
});

it('reports a stored Cline sign-in from session/new, on the local backend', async () => {
  expect(await check({ PATH: '/bin' })).toMatchObject({ status: 'authenticated' });
  expect(spawned).toHaveLength(1);
  expect(spawned[0]?.env.CLINE_SESSION_BACKEND_MODE).toBe('local');
});

it('reports signed out, with both ways to sign in, when Cline refuses the session', async () => {
  signedIn = false;
  const result = await check({ PATH: '/bin' });
  expect(result.status).toBe('unauthenticated');
  expect(result.message).toMatch(/cline auth/);
  expect(result.message).toMatch(/CLINE_PROVIDER and CLINE_API_KEY/);
});
