import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import * as providerProcess from '../provider-process';
import {
  checkKiroSignIn,
  createKiroAdapter,
  isKiroMethodAdvertised,
  kiroAcp,
  KIRO_LOGIN,
  KIRO_LOGIN_HINT,
  parseKiroWhoami,
} from './kiro-acp';

// Mock realpath
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof fs>()),
  realpath: async (path: string) => path,
}));

const servers: FakeAppServer[] = [];
const agentCapabilitiesState = {
  loadSession: true,
  mcpCapabilities: { http: true },
  _meta: {
    kiro: {
      extensionMethods: ['kiro/ask_question', 'kiro/action'],
    },
  },
};

vi.mock('node:child_process', () => ({
  spawn: () => {
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      agentCapabilities: agentCapabilitiesState,
    }));
    server.replyAlways('authenticate', () => ({}));
    server.replyAlways('session/new', () => ({
      sessionId: 'kiro-session-1',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          currentValue: 'claude-3-5-sonnet',
          options: [
            { value: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
            { value: 'claude-3-haiku', name: 'Claude 3 Haiku' },
          ],
        },
      ],
    }));
    server.replyAlways('session/load', () => ({
      sessionId: 'kiro-session-1',
      configOptions: [
        {
          id: 'model',
          type: 'select',
          currentValue: 'claude-3-5-sonnet',
          options: [{ value: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' }],
        },
      ],
    }));
    servers.push(server);
    return server;
  },
}));

async function setupSession(
  resume = false,
  runtimeMode: 'approval-required' | 'auto-accept-edits' | 'full-access' = 'approval-required'
) {
  const adapter = createKiroAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 'test-session',
    cwd: '/workspace',
    runtimeMode,
    env: {},
    mcpServers: {
      tools: { transport: 'stdio', command: 'node', args: ['server.js'] },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'kiro-session-1' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

describe('Kiro ACP Hooks', () => {
  beforeEach(() => {
    servers.length = 0;
    vi.restoreAllMocks();
  });

  describe('launch configuration', () => {
    it('launches Kiro ACP using V3 engine without V2 flags', async () => {
      const launch = await kiroAcp.launch({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: { FOO: 'bar' },
      });
      expect(launch.command).toBe('kiro-cli');
      expect(launch.args).toEqual(['acp', '--agent-engine=v3']);
      expect(launch.args).not.toContain('--agent');
      expect(launch.args).not.toContain('--model');
      expect(launch.args).not.toContain('--effort');
      expect(launch.args).not.toContain('--trust-all-tools');
      expect(launch.env).toEqual({ FOO: 'bar' });
    });

    it('defines expected default binary and login command', () => {
      expect(kiroAcp.defaultBinary).toBe('kiro-cli');
      expect(kiroAcp.loginCommand).toBe(KIRO_LOGIN);
      expect(kiroAcp.noLegacySetModel).toBe(true);
    });
  });

  describe('whoami output parser & fixtures', () => {
    it('parses valid builder-id authenticated JSON output', () => {
      const fixture = JSON.stringify({
        user: 'developer@example.com',
        email: 'developer@example.com',
        authenticated: true,
        status: 'active',
        authMethod: 'builder-id',
      });
      const result = parseKiroWhoami(fixture);
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('developer@example.com');
    });

    it('parses valid IAM authenticated JSON output', () => {
      const fixture = JSON.stringify({
        user: 'arn:aws:iam::123456789012:user/developer',
        authenticated: true,
        status: 'authenticated',
      });
      const result = parseKiroWhoami(fixture);
      expect(result.status).toBe('authenticated');
      expect(result.message).toContain('arn:aws:iam');
    });

    it('parses unauthenticated JSON output and provides device flow hint', () => {
      const fixture = JSON.stringify({
        authenticated: false,
        status: 'unauthenticated',
      });
      const result = parseKiroWhoami(fixture);
      expect(result.status).toBe('unauthenticated');
      expect(result.message).toBe(KIRO_LOGIN_HINT);
      expect(result.message).toContain('--use-device-flow');
    });

    it('parses plaintext unauthenticated and expired messages', () => {
      expect(parseKiroWhoami('Not logged in. Use kiro-cli login').status).toBe('unauthenticated');
      expect(parseKiroWhoami('Authentication required').status).toBe('unauthenticated');
      expect(parseKiroWhoami('Session expired. Please log in').status).toBe('unauthenticated');
    });

    it('handles malformed JSON and empty outputs as unknown', () => {
      expect(parseKiroWhoami('{ invalid json').status).toBe('unknown');
      expect(parseKiroWhoami('').status).toBe('unknown');
      expect(parseKiroWhoami('   \n  ').status).toBe('unknown');
    });
  });

  describe('checkKiroSignIn', () => {
    it('detects missing or uninstalled CLI binary as unconfigured', async () => {
      vi.spyOn(providerProcess, 'execProvider').mockRejectedValueOnce(
        Object.assign(new Error('spawn kiro-cli ENOENT'), { code: 'ENOENT' })
      );
      const res = await checkKiroSignIn({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: {},
      });
      expect(res.status).toBe('unconfigured');
      expect(res.message).toContain('not installed');
    });

    it('detects command not recognized on Windows as unconfigured', async () => {
      vi.spyOn(providerProcess, 'execProvider').mockRejectedValueOnce(
        new Error('kiro-cli is not recognized as an operable program')
      );
      const res = await checkKiroSignIn({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: {},
      });
      expect(res.status).toBe('unconfigured');
    });

    it('detects signed-in status on successful whoami call', async () => {
      vi.spyOn(providerProcess, 'execProvider').mockResolvedValueOnce({
        stdout: JSON.stringify({ authenticated: true, email: 'user@kiro.dev' }),
        stderr: '',
      });
      const res = await checkKiroSignIn({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: {},
      });
      expect(res.status).toBe('authenticated');
      expect(res.message).toContain('user@kiro.dev');
    });

    it('handles command failure with signed-out stderr as unauthenticated', async () => {
      vi.spyOn(providerProcess, 'execProvider').mockRejectedValueOnce(
        Object.assign(new Error('Process failed with exit code 1'), {
          stdout: '',
          stderr: 'Not logged in. Please run kiro-cli login',
        })
      );
      const res = await checkKiroSignIn({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: {},
      });
      expect(res.status).toBe('unauthenticated');
      expect(res.message).toContain(KIRO_LOGIN);
    });

    it('handles unexpected failure with generic error as unknown', async () => {
      vi.spyOn(providerProcess, 'execProvider').mockRejectedValueOnce(
        new Error('Unexpected network failure')
      );
      const res = await checkKiroSignIn({
        binaryPath: 'kiro-cli',
        cwd: '/work',
        env: {},
      });
      expect(res.status).toBe('unknown');
    });
  });

  describe('capability negotiation and optional methods', () => {
    it('negotiates advertised extension methods correctly', () => {
      const caps = {
        _meta: {
          kiro: {
            extensionMethods: ['kiro/ask_question'],
          },
        },
      };
      expect(isKiroMethodAdvertised(caps, 'kiro/ask_question')).toBe(true);
      expect(isKiroMethodAdvertised(caps, '_kiro.dev/commands/execute')).toBe(false);
      expect(isKiroMethodAdvertised(undefined, 'kiro/ask_question')).toBe(false);
    });

    it('rejects unadvertised optional requests with explicit jsonrpc error', async () => {
      const { server } = await setupSession();

      // Send request for unadvertised optional method
      const unadvertisedPromise = new Promise<{ error?: { code: number; message: string } }>(
        (resolve) => {
          server.stdout.on('data', (chunk) => {
            for (const line of chunk.toString('utf8').split('\n')) {
              if (line.trim()) {
                const msg = JSON.parse(line);
                if (msg.id === 999) resolve(msg);
              }
            }
          });
        }
      );

      server.send({
        id: 999,
        method: '_kiro.dev/commands/execute',
        params: { cmd: 'test' },
      });

      const response = await unadvertisedPromise;
      expect(response.error).toBeDefined();
      expect(response.error?.code).toBe(-32601);
    });
  });

  describe('session lifecycle & models', () => {
    it('starts session and loads models from configOptions', async () => {
      const { adapter, session } = await setupSession();
      expect(session.nativeSessionId).toBe('kiro-session-1');
      const models = await adapter.listModels(session.sessionId);
      expect(models).toEqual([
        { id: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
        { id: 'claude-3-haiku', name: 'Claude 3 Haiku' },
      ]);
    });

    it('sets model via session/set_config_option with configId model', async () => {
      const { adapter, server, session } = await setupSession();
      server.reply('session/set_config_option', (params) => {
        expect(params).toMatchObject({
          sessionId: 'kiro-session-1',
          configId: 'model',
          value: 'claude-3-haiku',
        });
        return {
          configOptions: [
            {
              id: 'model',
              type: 'select',
              currentValue: 'claude-3-haiku',
              options: [
                { value: 'claude-3-5-sonnet', name: 'Claude 3.5 Sonnet' },
                { value: 'claude-3-haiku', name: 'Claude 3 Haiku' },
              ],
            },
          ],
        };
      });

      await adapter.setModel(session.sessionId, { id: 'claude-3-haiku' });
      expect(server.received.some((m) => m.method === 'session/set_config_option')).toBe(true);
      expect(server.received.some((m) => m.method === 'session/set_model')).toBe(false);
    });

    it('restores cwd and mcp servers on session/load', async () => {
      const { server, session } = await setupSession(true);
      expect(session.nativeSessionId).toBe('kiro-session-1');
      const loadCall = server.received.find((m) => m.method === 'session/load');
      expect(loadCall?.params).toMatchObject({
        sessionId: 'kiro-session-1',
        cwd: '/workspace',
        mcpServers: [{ name: 'tools', command: 'node', args: ['server.js'] }],
      });
    });
  });

  describe('permission requests & approvals', () => {
    it('maps allow_once, allow_always, and reject_once to Switch decisions without permanent options', async () => {
      const { adapter, events, server, session } = await setupSession(false, 'approval-required');

      void adapter.sendTurn({ sessionId: session.sessionId, turnId: 'turn-1', text: 'run tool' });

      // Agent requests permission
      server.notify('session/update', {
        sessionId: 'kiro-session-1',
        update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Execute command' },
      });

      const decisionPromise = adapter.respondToRequest(session.sessionId, 'req-1', 'accept');

      // Server requests permission from client
      server.send({
        id: 101,
        method: 'session/request_permission',
        params: {
          sessionId: 'kiro-session-1',
          toolCall: { toolCallId: 'call-1', title: 'Execute command', kind: 'execute' },
          options: [
            { optionId: 'opt-once', name: 'Allow Once', kind: 'allow_once' },
            { optionId: 'opt-always', name: 'Allow for session', kind: 'allow_always' },
            { optionId: 'opt-perm', name: 'Permanent future consent', kind: 'allow_permanent' },
            { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
          ],
        },
      });

      const openedEvent = events.find((e) => e.type === 'request.opened') as {
        options: Array<{ decision: string; label: string }>;
      };
      expect(openedEvent).toBeDefined();
      // Verifies permanent consent option is filtered out
      expect(openedEvent.options.map((o) => o.decision)).toEqual([
        'accept',
        'acceptForSession',
        'decline',
        'cancel',
      ]);
      expect(openedEvent.options.some((o) => /permanent|future/i.test(o.label))).toBe(false);

      await decisionPromise;
    });

    it('auto-approves in full-access mode without presenting prompt to user', async () => {
      const { adapter, events, server, session } = await setupSession(false, 'full-access');

      void adapter.sendTurn({ sessionId: session.sessionId, turnId: 'turn-1', text: 'run tool' });

      const replyPromise = new Promise<{ result?: { outcome?: { optionId?: string } } }>(
        (resolve) => {
          server.stdout.on('data', (chunk) => {
            for (const line of chunk.toString('utf8').split('\n')) {
              if (line.trim()) {
                const msg = JSON.parse(line);
                if (msg.id === 202) resolve(msg);
              }
            }
          });
        }
      );

      server.send({
        id: 202,
        method: 'session/request_permission',
        params: {
          sessionId: 'kiro-session-1',
          toolCall: { toolCallId: 'call-auto', title: 'Write file', kind: 'edit' },
          options: [
            { optionId: 'once-1', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'deny-1', name: 'Deny', kind: 'reject_once' },
          ],
        },
      });

      const response = await replyPromise;
      expect(response.result?.outcome?.optionId).toBe('once-1');
      // No user request opened in full-access mode
      expect(events.some((e) => e.type === 'request.opened')).toBe(false);
    });
  });

  describe('mcpServerOf & itemType', () => {
    it('identifies MCP server from tool call _meta or rawInput', () => {
      expect(
        kiroAcp.mcpServerOf?.({
          toolCallId: '1',
          _meta: { kiro: { server: 'github-mcp' } },
        })
      ).toBe('github-mcp');

      expect(
        kiroAcp.mcpServerOf?.({
          toolCallId: '2',
          _meta: { serverName: 'jira-mcp' },
        })
      ).toBe('jira-mcp');

      expect(
        kiroAcp.mcpServerOf?.({
          toolCallId: '3',
          rawInput: { providerIdentifier: 'slack-mcp' },
        })
      ).toBe('slack-mcp');
    });

    it('identifies subagent tasks correctly', () => {
      expect(
        kiroAcp.itemType?.({
          toolCallId: '1',
          kind: 'subagent',
        })
      ).toBe('subagent');

      expect(
        kiroAcp.itemType?.({
          toolCallId: '2',
          title: 'Task: Explore repository',
        })
      ).toBe('subagent');
    });
  });
});

