import type * as fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpSessionContext } from '../acp/hooks';
import type { AcpPermissionRequest, AcpToolCall } from '../acp/protocol';
import { FakeAppServer } from '../codex/fake-app-server';
import type { ProviderRuntimeEvent } from '../events';
import {
  createGooseAdapter,
  gooseAcp,
  gooseItemType,
  gooseMcpServerOf,
  goosePermission,
  parseGooseInfo,
} from './goose-adapter';

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
    server.replyAlways('session/new', () => ({ sessionId: 'goose-native-123' }));
    server.replyAlways('session/load', () => ({ sessionId: 'goose-native-123' }));
    server.replyAlways('session/set_mode', () => ({}));
    server.replyAlways('session/set_model', () => ({}));
    servers.push(server);
    return server;
  },
}));

beforeEach(() => {
  servers.length = 0;
  acp.http = true;
});

async function setup(resume = false, env: Record<string, string> = {}) {
  const adapter = createGooseAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((e) => events.push(e));
  const session = await adapter.startSession({
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env,
    mcpServers: {
      switch: { transport: 'stdio', command: 'node', args: ['server.js'], env: { MODE: 'test' } },
    },
    connectorMcpServers: [],
    ...(resume ? { resume: { nativeSessionId: 'goose-native-123' } } : {}),
  });
  const server = servers.at(-1)!;
  return { adapter, events, server, session };
}

describe('Goose session modes', () => {
  it('maps each Switch runtime mode to the expected Goose ACP mode', () => {
    expect(gooseAcp.sessionMode?.('approval-required')).toBe('approve');
    expect(gooseAcp.sessionMode?.('auto-accept-edits')).toBe('approve');
    expect(gooseAcp.sessionMode?.('auto')).toBe('smart_approve');
    expect(gooseAcp.sessionMode?.('full-access')).toBe('auto');
  });

  it('declares the expected ACP capabilities for Goose', () => {
    expect(gooseAcp.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
  });

  it('inherits Goose specific environment variables', () => {
    expect(gooseAcp.inheritEnv).toEqual(['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_DISABLE_KEYRING']);
  });
});

describe('parseGooseInfo', () => {
  it('detects a successfully configured provider and model', () => {
    const output = `
Goose Version: 1.0.0
Provider: openai
Model: gpt-4o
    `.trim();
    expect(parseGooseInfo(output)).toEqual({
      status: 'authenticated',
      message: 'Signed in.',
      models: [],
    });
  });

  it('parses goose info with ANSI color escapes', () => {
    const output =
      '\u001b[32mProvider:\u001b[0m databricks\n\u001b[32mModel:\u001b[0m meta-llama-3-3-70b';
    expect(parseGooseInfo(output)).toEqual({
      status: 'authenticated',
      message: 'Signed in.',
      models: [],
    });
  });

  it('identifies pressly/goose migration tool on PATH as unknown', () => {
    const output =
      'goose: error: unknown command "info"\nUsage: goose [OPTIONS] DRIVER DBSTRING COMMAND';
    const result = parseGooseInfo(output);
    expect(result.status).toBe('unknown');
    expect(result.message).toContain('Found a non-Goose binary');
  });

  it('returns unauthenticated when provider is unset or missing', () => {
    const output = `
Goose Version: 1.0.0
Provider: not set
Model: not set
    `.trim();
    const result = parseGooseInfo(output);
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('goose configure');
  });

  it('returns unauthenticated when model is missing', () => {
    const output = 'Provider: openai\nModel: <none>';
    const result = parseGooseInfo(output);
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('goose configure');
  });

  it('returns unauthenticated on explicit unconfigured message', () => {
    const output = 'No provider configured. Run `goose configure` to set up.';
    const result = parseGooseInfo(output);
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('goose configure');
  });
});

describe('checkSignIn with environment override', () => {
  it('reports authenticated without running info when both GOOSE_PROVIDER and GOOSE_MODEL are in env', async () => {
    const result = await gooseAcp.checkSignIn?.({
      binaryPath: 'goose',
      cwd: '/fake',
      env: { GOOSE_PROVIDER: 'anthropic', GOOSE_MODEL: 'claude-3-5-sonnet' },
      handshake: async () => ({}) as never,
    });
    expect(result).toEqual({
      status: 'authenticated',
      message: 'Signed in with configured Goose provider and model.',
      models: [],
    });
  });
});

describe('gooseMcpServerOf', () => {
  it('returns undefined for built-in developer tools', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-1',
      title: 'developer: shell · ls',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'developer', toolName: 'shell' } } },
    };
    expect(gooseMcpServerOf(call)).toBeUndefined();
  });

  it('returns undefined for built-in summon tools', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-2',
      title: 'summon: delegate · task',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'summon', toolName: 'delegate' } } },
    };
    expect(gooseMcpServerOf(call)).toBeUndefined();
  });

  it('returns extensionName for external MCP tools', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-3',
      title: 'github: create_issue',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'github', toolName: 'create_issue' } } },
    };
    expect(gooseMcpServerOf(call)).toBe('github');
  });

  it('extracts server name from raw tool name prefix <server>__<tool>', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-4',
      title: 'sqlite query',
      kind: 'other',
      _meta: { goose: { toolCall: { toolName: 'sqlite__query' } } },
    };
    expect(gooseMcpServerOf(call)).toBe('sqlite');
  });
});

describe('gooseItemType', () => {
  it('identifies shell executions from metadata', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-1',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'developer', toolName: 'shell' } } },
    };
    expect(gooseItemType(call)).toBe('command_execution');
  });

  it('identifies shell executions from title', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-1',
      title: 'developer: shell · npm test',
      kind: 'other',
    };
    expect(gooseItemType(call)).toBe('command_execution');
  });

  it('identifies file changes from metadata', () => {
    const callWrite: AcpToolCall = {
      toolCallId: 'call-2',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'developer', toolName: 'write' } } },
    };
    const callEdit: AcpToolCall = {
      toolCallId: 'call-3',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'developer', toolName: 'edit' } } },
    };
    expect(gooseItemType(callWrite)).toBe('file_change');
    expect(gooseItemType(callEdit)).toBe('file_change');
  });

  it('identifies file changes from title', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-2',
      title: 'developer: write · src/app.ts',
      kind: 'other',
    };
    expect(gooseItemType(call)).toBe('file_change');
  });

  it('identifies subagent delegation', () => {
    const call: AcpToolCall = {
      toolCallId: 'call-4',
      title: 'summon: delegate · Research codebase',
      kind: 'other',
      _meta: { goose: { toolCall: { extensionName: 'summon', toolName: 'delegate' } } },
    };
    expect(gooseItemType(call)).toBe('subagent');
  });
});

describe('goosePermission', () => {
  it('filters out allow_always and reject_always and labels remaining options cleanly', () => {
    const mockContext = {} as AcpSessionContext;
    const request: AcpPermissionRequest = {
      sessionId: 'goose-native-123',
      toolCall: {
        toolCallId: 'tool-1',
        title: 'developer: shell · git status',
        kind: 'other',
      },
      options: [
        { optionId: 'opt-1', kind: 'allow_once', name: 'allow_once' },
        { optionId: 'opt-2', kind: 'allow_always', name: 'allow_always' },
        { optionId: 'opt-3', kind: 'reject_once', name: 'reject_once' },
        { optionId: 'opt-4', kind: 'reject_always', name: 'reject_always' },
      ],
    };

    const result = goosePermission(mockContext, request);
    expect(result).toBeUndefined();
    expect(request.options).toEqual([
      { optionId: 'opt-1', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'opt-3', kind: 'reject_once', name: 'Reject' },
    ]);
    expect(request.toolCall.kind).toBe('execute');
  });

  it('maps write and edit tools to kind edit', () => {
    const mockContext = {} as AcpSessionContext;
    const request: AcpPermissionRequest = {
      sessionId: 'goose-native-123',
      toolCall: {
        toolCallId: 'tool-2',
        title: 'developer: edit · file.txt',
        kind: 'other',
      },
      options: [{ optionId: 'opt-1', kind: 'allow_once', name: 'Allow once' }],
    };

    goosePermission(mockContext, request);
    expect(request.toolCall.kind).toBe('edit');
  });
});

describe('Goose adapter session lifecycle', () => {
  it('starts session, sets mode, registers MCP servers, and loads saved session on resume', async () => {
    const { server, session } = await setup(true);
    expect(session.nativeSessionId).toBe('goose-native-123');

    const setMode = server.received.find((m) => m.method === 'session/set_mode');
    expect(setMode?.params).toMatchObject({
      sessionId: 'goose-native-123',
      modeId: 'approve',
    });

    const loadSession = server.received.find((m) => m.method === 'session/load');
    expect(loadSession?.params).toMatchObject({
      sessionId: 'goose-native-123',
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
});
