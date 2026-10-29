import type * as fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import { parseDroidAuth } from './droid-acp';

vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
  readFile: vi.fn(),
}));

const servers: FakeAppServer[] = [];
const spawnCalls: Array<{ command: string; args: string[]; options: unknown }> = [];

const acp = {
  http: true,
  loadSession: true,
  resumeCapability: false,
  modelsFromConfig: true,
  authMethods: [] as Array<{ id: string; name: string }>,
};

vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[], options: unknown) => {
    spawnCalls.push({ command, args, options });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: {
        loadSession: acp.loadSession,
        ...(acp.resumeCapability ? { sessionCapabilities: { resume: {} } } : {}),
        ...(acp.http ? { mcpCapabilities: { http: true } } : {}),
      },
      authMethods: acp.authMethods,
    }));
    server.replyAlways('session/new', () => ({
      sessionId: 'droid-native-1',
      configOptions: acp.modelsFromConfig
        ? [
            {
              id: 'model',
              type: 'select',
              options: [
                { value: 'gpt-5', name: 'GPT 5' },
                { value: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
              ],
            },
          ]
        : [],
      models: acp.modelsFromConfig
        ? undefined
        : {
            availableModels: [
              { modelId: 'gpt-5', name: 'GPT 5' },
              { modelId: 'claude-3-7-sonnet', name: 'Claude 3.7 Sonnet' },
            ],
          },
    }));
    server.replyAlways('session/load', () => ({ sessionId: 'droid-native-1' }));
    server.replyAlways('session/resume', () => ({ sessionId: 'droid-native-1' }));
    server.replyAlways('session/set_config_option', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

const { createDroidAdapter, droidAcp, DROID_LOGIN } = await import('./droid-acp');

beforeEach(() => {
  servers.length = 0;
  spawnCalls.length = 0;
  acp.http = true;
  acp.loadSession = true;
  acp.resumeCapability = false;
  acp.modelsFromConfig = true;
  acp.authMethods = [];
});

afterEach(() => {
  for (const server of servers) server.kill();
});

async function setup(
  options: {
    resume?: boolean;
    runtimeMode?: 'approval-required' | 'full-access' | 'auto-accept-edits' | 'auto';
    env?: Record<string, string>;
    model?: { id: string };
  } = {}
) {
  const adapter = createDroidAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 'session-1',
    cwd: '/workspace',
    runtimeMode: options.runtimeMode ?? 'approval-required',
    env: options.env ?? { FACTORY_API_KEY: 'test-key' },
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(options.resume ? { resume: { nativeSessionId: 'droid-native-1' } } : {}),
    ...(options.model ? { model: options.model } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('Factory Droid ACP Provider', () => {
  it('launches with droid exec --output-format acp preserving binary and args', async () => {
    const launch = await droidAcp.launch({
      binaryPath: 'custom-droid',
      cwd: '/workspace',
      env: { CUSTOM: '1' },
    });
    expect(launch).toEqual({
      command: 'custom-droid',
      args: ['exec', '--output-format', 'acp'],
      env: { CUSTOM: '1' },
    });
  });

  it('declares FACTORY_API_KEY in inheritEnv', () => {
    expect(droidAcp.inheritEnv).toContain('FACTORY_API_KEY');
    expect(droidAcp.loginCommand).toBe(DROID_LOGIN);
  });

  describe('sign-in detection', () => {
    it('reports authenticated when FACTORY_API_KEY is present in env without calling handshake', async () => {
      const handshake = vi.fn();
      const res = await droidAcp.checkSignIn!({
        binaryPath: 'droid',
        cwd: '/work',
        env: { FACTORY_API_KEY: 'secret-api-key' },
        handshake,
      });
      expect(res.status).toBe('authenticated');
      expect(res.message).toBe('Signs in with the Factory API key it was given.');
      expect(handshake).not.toHaveBeenCalled();
    });

    it('reports authenticated when handshake returns no authMethods', async () => {
      const handshake = vi.fn().mockResolvedValue({ authMethods: [] });
      const res = await droidAcp.checkSignIn!({
        binaryPath: 'droid',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(res.status).toBe('authenticated');
      expect(res.message).toBe('Signed in to Factory Droid.');
    });

    it('reports unauthenticated with sign-in hint when handshake returns authMethods and no auth exists', async () => {
      const handshake = vi.fn().mockResolvedValue({
        authMethods: [{ id: 'oauth', name: 'Browser OAuth' }],
      });
      const res = await droidAcp.checkSignIn!({
        binaryPath: 'droid',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(res.status).toBe('unauthenticated');
      expect(res.message).toContain('Sign in on the execution machine with droid');
    });

    it('reports unauthenticated when handshake throws an authentication error', async () => {
      const handshake = vi
        .fn()
        .mockRejectedValue(new Error('authentication required: not logged in'));
      const res = await droidAcp.checkSignIn!({
        binaryPath: 'droid',
        cwd: '/work',
        env: {},
        handshake,
      });
      expect(res.status).toBe('unauthenticated');
      expect(res.message).toContain('Sign in on the execution machine with droid');
    });

    it('re-throws non-auth handshake errors', async () => {
      const handshake = vi.fn().mockRejectedValue(new Error('spawn droid ENOENT'));
      await expect(
        droidAcp.checkSignIn!({
          binaryPath: 'droid',
          cwd: '/work',
          env: {},
          handshake,
        })
      ).rejects.toThrow('ENOENT');
    });

    it('parses auth state correctly in parseDroidAuth helper', () => {
      expect(parseDroidAuth({ FACTORY_API_KEY: 'key' }, {}, false).status).toBe('authenticated');
      expect(parseDroidAuth({}, { authMethods: [] }, false).status).toBe('authenticated');
      expect(parseDroidAuth({}, { authMethods: [{ id: 'oauth' }] }, true).status).toBe(
        'authenticated'
      );
      expect(parseDroidAuth({}, { authMethods: [{ id: 'oauth' }] }, false).status).toBe(
        'unauthenticated'
      );
    });
  });

  describe('capabilities and model selection', () => {
    it('sets model via session/set_config_option when model config option is advertised', async () => {
      acp.modelsFromConfig = true;
      const { server } = await setup({ model: { id: 'gpt-5' } });
      expect(
        server.received.some(
          (m) =>
            m.method === 'session/set_config_option' &&
            m.params?.configId === 'model' &&
            m.params?.value === 'gpt-5'
        )
      ).toBe(true);
    });

    it('sets model via session/set_model when models list is advertised', async () => {
      acp.modelsFromConfig = false;
      const { server } = await setup({ model: { id: 'claude-3-7-sonnet' } });
      expect(
        server.received.some(
          (m) => m.method === 'session/set_model' && m.params?.modelId === 'claude-3-7-sonnet'
        )
      ).toBe(true);
    });
  });

  describe('session resume and isolation', () => {
    it('resumes native session via session/load when loadSession is advertised', async () => {
      acp.loadSession = true;
      const { server, session } = await setup({ resume: true });
      expect(session.nativeSessionId).toBe('droid-native-1');
      const loadMessage = server.received.find((m) => m.method === 'session/load');
      expect(loadMessage?.params).toMatchObject({
        sessionId: 'droid-native-1',
        cwd: '/workspace',
      });
    });

    it('resumes native session via session/resume when sessionCapabilities.resume is advertised', async () => {
      acp.loadSession = false;
      acp.resumeCapability = true;
      const { server, session } = await setup({ resume: true });
      expect(session.nativeSessionId).toBe('droid-native-1');
      const resumeMessage = server.received.find((m) => m.method === 'session/resume');
      expect(resumeMessage?.params).toMatchObject({
        sessionId: 'droid-native-1',
        cwd: '/workspace',
      });
    });

    it('ignores session/update notifications from other sessions', async () => {
      const { adapter, events, server } = await setup();
      const update = (sessionId: string, u: Record<string, unknown>) =>
        server.notify('session/update', { sessionId, update: u });

      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hello' });
      update('other-session-id', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'leak from other room' },
      });
      update('droid-native-1', {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'correct room text' },
      });

      const deltas = events.filter((e) => e.type === 'content.delta');
      expect(deltas.some((d) => 'delta' in d && d.delta.includes('leak from other room'))).toBe(
        false
      );
      expect(deltas.some((d) => 'delta' in d && d.delta.includes('correct room text'))).toBe(true);
    });
  });

  describe('permission handling and MCP tools', () => {
    it('identifies MCP server name from tool call _meta or rawInput', () => {
      expect(
        droidAcp.mcpServerOf!({
          toolCallId: 'call-1',
          _meta: { mcp: { server: 'github' } },
        } as never)
      ).toBe('github');

      expect(
        droidAcp.mcpServerOf!({
          toolCallId: 'call-2',
          _meta: { server: 'jira' },
        } as never)
      ).toBe('jira');

      expect(
        droidAcp.mcpServerOf!({
          toolCallId: 'call-3',
          rawInput: { providerIdentifier: 'slack' },
        } as never)
      ).toBe('slack');
    });

    it('auto-approves tool calls belonging to registered session MCP servers', async () => {
      const { adapter, events, server } = await setup({ runtimeMode: 'approval-required' });
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'call mcp' });

      server.send({
        id: 101,
        method: 'session/request_permission',
        params: {
          sessionId: 'droid-native-1',
          toolCall: {
            toolCallId: 'tc-switch',
            title: 'Call switch tool',
            kind: 'execute',
            _meta: { mcp: { server: 'switch' } },
          },
          options: [{ optionId: 'opt-allow', name: 'Allow once', kind: 'allow_once' }],
        },
      });
      await flush();

      // No approval opened in Console
      expect(events.filter((e) => e.type === 'request.opened')).toHaveLength(0);
      // Auto-approved response sent to Droid
      expect(server.received.find((m) => m.id === 101)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'opt-allow' },
      });
    });

    it('opens approval request for non-registered actions and handles accept', async () => {
      const { adapter, events, server } = await setup({ runtimeMode: 'approval-required' });
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'edit code' });

      server.send({
        id: 102,
        method: 'session/request_permission',
        params: {
          sessionId: 'droid-native-1',
          toolCall: {
            toolCallId: 'tc-edit',
            title: 'Edit index.ts',
            kind: 'edit',
          },
          options: [
            { optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
          ],
        },
      });
      await flush();

      const request = events.find((e) => e.type === 'request.opened');
      expect(request).toBeDefined();
      if (!request || request.type !== 'request.opened') throw new Error('missing request');

      await adapter.respondToRequest('session-1', request.requestId, 'accept');
      await flush();

      expect(server.received.find((m) => m.id === 102)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-1' },
      });
    });

    it('cancels permission request when user declines', async () => {
      const { adapter, events, server } = await setup({ runtimeMode: 'approval-required' });
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'delete file' });

      server.send({
        id: 103,
        method: 'session/request_permission',
        params: {
          sessionId: 'droid-native-1',
          toolCall: {
            toolCallId: 'tc-delete',
            title: 'Delete file',
            kind: 'execute',
          },
          options: [{ optionId: 'allow-1', name: 'Allow once', kind: 'allow_once' }],
        },
      });
      await flush();

      const request = events.find((e) => e.type === 'request.opened');
      if (!request || request.type !== 'request.opened') throw new Error('missing request');

      await adapter.respondToRequest('session-1', request.requestId, 'decline');
      await flush();

      expect(server.received.find((m) => m.id === 103)?.result).toEqual({
        outcome: { outcome: 'cancelled' },
      });
    });
  });

  describe('cancellation and interruption', () => {
    it('sends session/cancel, cancels pending approvals, and marks turn interrupted', async () => {
      const { adapter, events, server } = await setup();
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'long task' });
      const prompt = await server.waitFor('session/prompt');

      server.send({
        id: 104,
        method: 'session/request_permission',
        params: {
          sessionId: 'droid-native-1',
          toolCall: { toolCallId: 'tc-pending', title: 'Pending tool', kind: 'execute' },
          options: [{ optionId: 'opt', name: 'Allow', kind: 'allow_once' }],
        },
      });
      await flush();

      await adapter.interruptTurn('session-1');
      await flush();

      expect(server.received.find((m) => m.method === 'session/cancel')?.params).toEqual({
        sessionId: 'droid-native-1',
      });
      expect(server.received.find((m) => m.id === 104)?.result).toEqual({
        outcome: { outcome: 'cancelled' },
      });

      server.send({ id: prompt.id, result: { stopReason: 'cancelled' } });
      await flush();

      expect(events.find((e) => e.type === 'turn.completed')).toMatchObject({
        turnId: 'turn-1',
        outcome: 'interrupted',
      });
    });
  });

  describe('process lifecycle errors', () => {
    it('settles queued turns on unexpected process exit', async () => {
      const { adapter, events, server } = await setup();
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'first' });
      await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-2', text: 'second' });

      server.kill('SIGTERM');
      await flush();

      expect(adapter.hasSession('session-1')).toBe(false);
      expect(events.filter((e) => e.type === 'turn.completed').map((e) => e.outcome)).toEqual([
        'error',
        'error',
      ]);
    });
  });
});
