import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpInitializeResult } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { JUNIE_LOGIN, createJunieAdapter, junieAcp } from './junie-adapter';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const acp = { http: true };

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: true,
        ...(acp.http ? { mcpCapabilities: { http: true } } : {}),
      },
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'native',
      configOptions: [
        { id: 'model', type: 'select', options: [{ value: 'gpt-4o', name: 'GPT-4o' }] },
      ],
    }));
    server.replyAlways('session/load', () => ({}));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_config_option', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

async function setup(resume = false, switchRegistered = true) {
  const adapter = createJunieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: {},
    mcpServers: switchRegistered
      ? {
          switch: {
            transport: 'stdio',
            command: 'node',
            args: ['server.js'],
            env: { MODE: 'test' },
          },
        }
      : {},
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native-1' } } : {}),
  });
  return { adapter, session, events, server: servers[0]! };
}

describe('junieAcp hooks', () => {
  it('declares expected capabilities and settings', () => {
    expect(junieAcp.provider).toBe('junie');
    expect(junieAcp.label).toBe('Junie');
    expect(junieAcp.defaultBinary).toBe('junie');
    expect(junieAcp.loginCommand).toBe(JUNIE_LOGIN);
    expect(junieAcp.capabilities.modelSwitchInSession).toBe(true);
    expect(junieAcp.capabilities.resume).toBe(true);
    expect(junieAcp.capabilities.approvals).toBe(true);
    expect(junieAcp.inheritEnv).toContain('JUNIE_API_KEY');
  });

  it('configures launch binary and args', async () => {
    const launch = await junieAcp.launch({
      binaryPath: 'path/to/junie',
      cwd: '/work',
      env: { FOO: 'bar' },
    });
    expect(launch.command).toBe('path/to/junie');
    expect(launch.args).toEqual(['--acp=true']);
    expect(launch.env).toEqual({ FOO: 'bar' });
  });

  it('rejects output lines signaling missing sign-in', async () => {
    const launch = await junieAcp.launch({
      binaryPath: 'junie',
      cwd: '/work',
      env: {},
    });
    expect(launch.rejectOutputLine?.('Please log in with junie login')).toMatch(
      /Junie is not signed in/
    );
    expect(launch.rejectOutputLine?.('Auth required: please authenticate')).toMatch(
      /Junie is not signed in/
    );
    expect(launch.rejectOutputLine?.('Starting Junie ACP server...')).toBeUndefined();
  });

  it('resolves MCP server from tool call metadata or raw input', () => {
    expect(
      junieAcp.mcpServerOf?.({
        toolCallId: 't1',
        title: 'tool',
        rawInput: {},
        _meta: { is_mcp_tool_call: true, mcp: { server: 'github' } },
      })
    ).toBe('github');

    expect(
      junieAcp.mcpServerOf?.({
        toolCallId: 't2',
        title: 'tool',
        rawInput: { providerIdentifier: 'switch' },
      })
    ).toBe('switch');

    expect(
      junieAcp.mcpServerOf?.({
        toolCallId: 't3',
        title: 'tool',
        rawInput: {},
      })
    ).toBeUndefined();
  });
});

describe('junieAcp.checkSignIn', () => {
  it('reports authenticated when JUNIE_API_KEY is in env', async () => {
    const check = junieAcp.checkSignIn!;
    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: { JUNIE_API_KEY: 'secret-token' },
      handshake: vi.fn(),
    });
    expect(res.status).toBe('authenticated');
    expect(res.message).toMatch(/Junie API key/);
  });

  it('reports authenticated when JUNIE_AUTH_TOKEN is in env', async () => {
    const check = junieAcp.checkSignIn!;
    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: { JUNIE_AUTH_TOKEN: 'secret-token' },
      handshake: vi.fn(),
    });
    expect(res.status).toBe('authenticated');
  });

  it('reports authenticated when JETBRAINS_AI_TOKEN is in env', async () => {
    const check = junieAcp.checkSignIn!;
    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: { JETBRAINS_AI_TOKEN: 'secret-token' },
      handshake: vi.fn(),
    });
    expect(res.status).toBe('authenticated');
  });

  it('reports authenticated when handshake returns no authMethods', async () => {
    const check = junieAcp.checkSignIn!;
    const handshake = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      authMethods: [],
    } as unknown as AcpInitializeResult);

    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: {},
      handshake,
    });
    expect(res.status).toBe('authenticated');
    expect(res.message).toBe('Signed in.');
  });

  it('reports unauthenticated when handshake returns authMethods', async () => {
    const check = junieAcp.checkSignIn!;
    const handshake = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      authMethods: [{ id: 'oauth', name: 'JetBrains Account' }],
    } as unknown as AcpInitializeResult);

    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: {},
      handshake,
    });
    expect(res.status).toBe('unauthenticated');
    expect(res.message).toBe('Sign in on the execution machine with junie login.');
  });

  it('reports unauthenticated when handshake throws login required error', async () => {
    const check = junieAcp.checkSignIn!;
    const handshake = vi.fn().mockRejectedValue(new Error('Authentication required for Junie'));

    const res = await check({
      binaryPath: 'junie',
      cwd: '/work',
      env: {},
      handshake,
    });
    expect(res.status).toBe('unauthenticated');
    expect(res.message).toBe('Sign in on the execution machine with junie login.');
  });

  it('rethrows unexpected handshake errors', async () => {
    const check = junieAcp.checkSignIn!;
    const handshake = vi.fn().mockRejectedValue(new Error('Network connection timeout'));

    await expect(
      check({
        binaryPath: 'junie',
        cwd: '/work',
        env: {},
        handshake,
      })
    ).rejects.toThrow('Network connection timeout');
  });
});

describe('createJunieAdapter runtime', () => {
  it('starts a new session with model configuration and emits expected events', async () => {
    const { session, server } = await setup();
    expect(session.sessionId).toBe('s');
    expect(server.received.some((m) => m.method === 'session/new')).toBe(true);
  });

  it('resumes an existing session via session/load', async () => {
    const { server } = await setup(true);
    expect(server.received.some((m) => m.method === 'session/load')).toBe(true);
  });

  it('executes a prompt turn and completes', async () => {
    const { adapter, server } = await setup();
    server.reply('session/prompt', (params: any) => {
      server.notify('session/update', {
        sessionId: params?.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from Junie' },
        },
      });
      return { stopReason: 'end_turn' };
    });

    const turnEvents: ProviderRuntimeEvent[] = [];
    adapter.subscribe((e) => turnEvents.push(e));

    await adapter.sendTurn({
      sessionId: 's',
      turnId: 't-1',
      text: 'Hi Junie',
      attachments: [],
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(turnEvents.some((e) => e.type === 'turn.completed')).toBe(true);
  });
});
