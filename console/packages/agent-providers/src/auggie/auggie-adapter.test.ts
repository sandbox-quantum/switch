import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import type * as providerProcess from '../provider-process';
import {
  AUGGIE_LOGIN,
  auggieAcp,
  createAuggieAdapter,
  parseAuggieTokenPrint,
} from './auggie-adapter';

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
        {
          id: 'model',
          type: 'select',
          options: [{ value: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }],
        },
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

vi.mock('../provider-process', async (original) => {
  const actual = await original<typeof providerProcess>();
  return {
    ...actual,
    execProvider: vi.fn(),
  };
});

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
  vi.clearAllMocks();
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createAuggieAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'native' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('parseAuggieTokenPrint', () => {
  it('identifies signed in state from valid token JSON', () => {
    const jsonOutput = JSON.stringify({
      accessToken: 'test-token-123',
      tenantURL: 'https://api.augmentcode.com',
    });
    const result = parseAuggieTokenPrint(jsonOutput);
    expect(result.status).toBe('authenticated');
    expect(result.message).toBe('Signed in.');
  });

  it('identifies signed in state when JSON has surrounding text or whitespace', () => {
    const jsonOutput = `Session info:\n{"accessToken":"test-token","tenantURL":"https://api.augmentcode.com"}\nReady.`;
    const result = parseAuggieTokenPrint(jsonOutput);
    expect(result.status).toBe('authenticated');
  });

  it('identifies unauthenticated state when output mentions not logged in', () => {
    const result = parseAuggieTokenPrint('Error: not logged in. Run auggie login.');
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain(AUGGIE_LOGIN);
  });

  it('identifies unauthenticated state on empty output', () => {
    const result = parseAuggieTokenPrint('');
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain(AUGGIE_LOGIN);
  });

  it('identifies unauthenticated state on error output without json', () => {
    const result = parseAuggieTokenPrint('Failed to retrieve token: no active session found.');
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain(AUGGIE_LOGIN);
  });

  it('returns unknown status for unrecognized non-error output', () => {
    const result = parseAuggieTokenPrint('Some unknown diagnostic output without keywords');
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Could not verify authentication');
  });
});

describe('auggieAcp hooks', () => {
  it('declares expected capabilities and properties', () => {
    expect(auggieAcp.provider).toBe('auggie');
    expect(auggieAcp.label).toBe('Auggie');
    expect(auggieAcp.defaultBinary).toBe('auggie');
    expect(auggieAcp.loginCommand).toBe('auggie login');
    expect(auggieAcp.inheritEnv).toContain('AUGMENT_SESSION_AUTH');
    expect(auggieAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect(auggieAcp.promptCapabilities).toEqual({ image: true });
  });

  it('launches with --acp and configures rejectOutputLine', async () => {
    const launch = await auggieAcp.launch({
      binaryPath: 'auggie',
      cwd: '/work',
      env: { FOO: 'bar' },
    });
    expect(launch.command).toBe('auggie');
    expect(launch.args).toEqual(['--acp']);
    expect(launch.env).toEqual({ FOO: 'bar' });
    expect(launch.rejectOutputLine?.('Please log in with auggie login')).toContain(
      'Auggie is not signed in'
    );
    expect(launch.rejectOutputLine?.('Normal output line')).toBeUndefined();
  });

  it('checks sign in with AUGMENT_SESSION_AUTH without invoking the CLI', async () => {
    const { execProvider } = await import('../provider-process');
    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: '/work',
      env: { AUGMENT_SESSION_AUTH: '{"accessToken":"secret"}' },
      handshake: vi.fn(),
    });
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('Augment session authentication');
    expect(execProvider).not.toHaveBeenCalled();
  });

  it('checks sign in via execProvider token print when no env auth is present', async () => {
    const { execProvider } = await import('../provider-process');
    vi.mocked(execProvider).mockResolvedValueOnce({
      stdout: '{"accessToken":"live-token"}',
      stderr: '',
    });
    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: '/work',
      env: {},
      handshake: vi.fn(),
    });
    expect(result.status).toBe('authenticated');
    expect(execProvider).toHaveBeenCalledWith(
      'auggie',
      ['token', 'print'],
      expect.objectContaining({ cwd: '/work' })
    );
  });

  it('returns unauthenticated when execProvider fails with not logged in', async () => {
    const { execProvider } = await import('../provider-process');
    vi.mocked(execProvider).mockRejectedValueOnce({
      stdout: '',
      stderr: 'not logged in',
    });
    const result = await auggieAcp.checkSignIn!({
      binaryPath: 'auggie',
      cwd: '/work',
      env: {},
      handshake: vi.fn(),
    });
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('auggie login');
  });

  it('identifies MCP server from _meta and rawInput in tool calls', () => {
    expect(
      auggieAcp.mcpServerOf!({
        toolCallId: 't1',
        _meta: { is_mcp_tool_call: true, mcp: { server: 'custom_mcp' } },
      })
    ).toBe('custom_mcp');

    expect(
      auggieAcp.mcpServerOf!({
        toolCallId: 't2',
        rawInput: { providerIdentifier: 'switch' },
      })
    ).toBe('switch');

    expect(
      auggieAcp.mcpServerOf!({
        toolCallId: 't3',
        rawInput: {},
      })
    ).toBeUndefined();
  });
});

describe('createAuggieAdapter runtime', () => {
  it('registers session MCP servers and resumes native session', async () => {
    const { server, session } = await setup(true);
    expect(session.nativeSessionId).toBe('native');
    expect(server.received.find((m) => m.method === 'session/load')?.params).toMatchObject({
      sessionId: 'native',
      mcpServers: [
        {
          name: 'switch',
          command: 'node',
          args: ['server.js'],
          env: [{ name: 'MODE', value: 'test' }],
        },
      ],
    });
  });

  it('lists models and configures model via session/set_config_option', async () => {
    const { adapter, server } = await setup();
    const models = await adapter.listModels('s');
    expect(models).toMatchObject([{ id: 'claude-3-5-sonnet' }]);

    await adapter.setModel('s', { id: 'claude-3-5-sonnet' });
    expect(server.received.find((m) => m.method === 'session/set_config_option')?.params).toEqual({
      sessionId: 'native',
      configId: 'model',
      value: 'claude-3-5-sonnet',
    });
  });

  it('auto-approves registered MCP tool calls and asks for unregistered ones', async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run tool' });
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'mcp-call',
        kind: 'other',
        title: 'switch: list_rooms',
        rawInput: { providerIdentifier: 'switch' },
      },
    });

    const options = [{ optionId: 'once', name: 'Allow once', kind: 'allow_once' }];
    server.send({
      id: 90,
      method: 'session/request_permission',
      params: { sessionId: 'native', toolCall: { toolCallId: 'mcp-call', kind: 'other' }, options },
    });
    await flush();

    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
    expect(server.received.find((m) => m.id === 90)?.result).toEqual({
      outcome: { outcome: 'selected', optionId: 'once' },
    });

    server.send({
      id: 91,
      method: 'session/request_permission',
      params: {
        sessionId: 'native',
        toolCall: { toolCallId: 'unregistered', kind: 'other', title: 'other: unknown' },
        options,
      },
    });
    await flush();
    expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(1);
  });

  it('interrupts the turn when interruptTurn is called', async () => {
    const { adapter, events, server } = await setup();
    await adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'first' });
    const prompt = await server.waitFor('session/prompt');

    await adapter.interruptTurn('s');
    await flush();

    expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
      sessionId: 'native',
    });
    server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
    await flush();

    expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
      turnId: 't1',
      outcome: 'interrupted',
    });
  });
});
