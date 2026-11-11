import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import util from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSessionStartInput } from '../adapter';
import { FakeAppServer } from '../codex/fake-app-server';
import { EventRecorder } from '../testing/event-recorder';

const servers: FakeAppServer[] = [];
const launches: Array<{ command: string; args: string[] }> = [];
const MODEL = JSON.stringify(['deepseek-official', 'deepseek-v4-pro']);
const CONFIG = [
  {
    id: 'model',
    type: 'select',
    currentValue: MODEL,
    options: [{ group: 'DeepSeek', options: [{ value: MODEL, name: 'DeepSeek V4 Pro' }] }],
  },
];
vi.mock('node:child_process', () => ({
  spawn: (command: string, args: string[]) => {
    launches.push({ command, args });
    const server = new FakeAppServer();
    server.replyAlways('initialize', () => ({
      protocolVersion: 1,
      authMethods: [],
      agentCapabilities: {
        mcpCapabilities: { http: true },
        sessionCapabilities: { resume: {} },
      },
    }));
    server.replyAlways('session/new', () => ({ sessionId: 'native', configOptions: CONFIG }));
    server.replyAlways('session/resume', () => ({ configOptions: CONFIG }));
    server.replyAlways('session/set_config_option', () => ({ configOptions: CONFIG }));
    servers.push(server);
    return server;
  },
}));
const { createDeepseekHarnessAdapter, deepseekHarnessAcp } = await import('./deepseek-harness-acp');

let cwd: string;
let home: string;
const adapters: ReturnType<typeof createDeepseekHarnessAdapter>[] = [];
beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), 'switch-dsh-'));
  home = await mkdtemp(join(tmpdir(), 'switch-dsh-home-'));
  servers.length = 0;
  launches.length = 0;
});
afterEach(async () => {
  await Promise.all(adapters.splice(0).map((adapter) => adapter.stopAll()));
  await Promise.all([cwd, home].map((dir) => rm(dir, { recursive: true, force: true })));
});

async function status(env: Record<string, string> = {}) {
  const handshake = vi.fn(async () => ({ authMethods: [] }));
  const result = await deepseekHarnessAcp.checkSignIn!({
    binaryPath: 'dsh',
    cwd,
    env: { DSH_HOME: home, ...env },
    handshake,
    request: async () => {
      throw new Error('Unexpected sign-in request');
    },
  });
  return { result, handshake };
}

describe('credential checks', () => {
  it('does not mistake an empty authMethods list for model authentication', async () => {
    const { result, handshake } = await status();
    expect(result.status).toBe('unauthenticated');
    expect(result.message).toContain('dsh web');
    expect(result.message).toContain('DEEPSEEK_API_KEY');
    expect(handshake).not.toHaveBeenCalled();
    expect(launches).toEqual([]);
  });

  it('checks configured launch credentials without authenticating or prompting', async () => {
    const { result, handshake } = await status({ DEEPSEEK_API_KEY: 'configured-placeholder' });
    expect(result.status).toBe('authenticated');
    expect(result.message).toContain('validity is checked on the first model request');
    expect(handshake).toHaveBeenCalledOnce();
  });

  it('recognizes the owner-only versioned credential store', async () => {
    await writeFile(
      join(home, '.credentials.yaml'),
      'version: 1\nrefs:\n  DEEPSEEK_API_KEY: configured-placeholder\n',
      { mode: 0o600 }
    );
    expect((await status()).result.status).toBe('authenticated');
    expect((await status({ DEEPSEEK_API_KEY: '' })).result.status).toBe('authenticated');
  });

  it('does not let a nonempty environment key hide invalid stored credentials', async () => {
    await writeFile(join(home, '.credentials.yaml'), 'version: [', { mode: 0o600 });
    const { result, handshake } = await status({ DEEPSEEK_API_KEY: 'configured-placeholder' });
    expect(result.status).toBe('unknown');
    expect(handshake).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a credential file readable by other users',
    async () => {
      await writeFile(
        join(home, '.credentials.yaml'),
        'version: 1\nrefs:\n  DEEPSEEK_API_KEY: configured-placeholder\n',
        { mode: 0o644 }
      );
      expect((await status()).result.status).toBe('unknown');
    }
  );

  it('recognizes project and home dotenv fallbacks, respecting an empty launch override', async () => {
    await writeFile(join(home, '.env'), 'DEEPSEEK_API_KEY=configured-placeholder\n');
    expect((await status()).result.status).toBe('authenticated');
    await writeFile(join(cwd, '.env'), 'DEEPSEEK_API_KEY=\n');
    expect((await status()).result.status).toBe('unauthenticated');
    await writeFile(join(cwd, '.env'), 'DEEPSEEK_API_KEY=configured-placeholder\n');
    expect((await status()).result.status).toBe('authenticated');
    expect((await status({ DEEPSEEK_API_KEY: ' ' })).result.status).toBe('unauthenticated');
  });

  it('reports unknown for custom stored grants rather than guessing their validity', async () => {
    await writeFile(
      join(home, '.credentials.yaml'),
      'version: 1\nrecords:\n  custom/provider:\n    kind: grant\n    payload: {}\n',
      { mode: 0o600 }
    );
    expect((await status()).result.status).toBe('unknown');
  });

  it('does not report a custom credential reference as a confirmed missing login', async () => {
    await writeFile(
      join(home, '.credentials.yaml'),
      'version: 1\nrefs:\n  CUSTOM_MODEL_KEY: configured-placeholder\n',
      { mode: 0o600 }
    );
    expect((await status()).result.status).toBe('unknown');
  });

  it.each([
    '42',
    '[]',
    'version: 2',
    'version: 1\nrefs: []',
    'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ""',
    'version: 1\nrecords: []',
  ])('reports an invalid store as unknown even when there is no launch key: %s', async (text) => {
    await writeFile(join(home, '.credentials.yaml'), text, { mode: 0o600 });
    const { result, handshake } = await status();
    expect(result.status).toBe('unknown');
    expect(handshake).not.toHaveBeenCalled();
  });

  it.each(['', '   ', '~/.dsh', '~\\.dsh'])(
    'resolves the DSH home like the launcher for %j',
    async (dshHome) => {
      await mkdir(join(home, '.dsh'));
      await writeFile(join(home, '.dsh', '.env'), 'DEEPSEEK_API_KEY=configured-placeholder\n');
      const { result } = await status({ HOME: home, DSH_HOME: dshHome });
      expect(result.status).toBe('authenticated');
    }
  );

  it('resolves a relative DSH home against the execution directory', async () => {
    await mkdir(join(cwd, 'profile-home'));
    await writeFile(join(cwd, 'profile-home', '.env'), 'DEEPSEEK_API_KEY=configured-placeholder\n');
    expect((await status({ DSH_HOME: 'profile-home' })).result.status).toBe('authenticated');
  });

  it('accepts empty credential sections and falls back to the launch key', async () => {
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\nrecords:\n', {
      mode: 0o600,
    });
    expect((await status({ DEEPSEEK_API_KEY: 'configured-placeholder' })).result.status).toBe(
      'authenticated'
    );
  });

  it('does not leak boot errors or credential values into readiness', async () => {
    const result = await deepseekHarnessAcp.checkSignIn!({
      binaryPath: 'dsh',
      cwd,
      env: { DSH_HOME: home, DEEPSEEK_API_KEY: 'configured-placeholder' },
      handshake: async () => {
        throw new Error('private-provider-output');
      },
      request: async () => {
        throw new Error('Unexpected sign-in request');
      },
    });
    expect(result.status).toBe('unknown');
    expect(result.message).not.toContain('private-provider-output');
    expect(result.message).not.toContain('configured-placeholder');
  });

  it('reports an unavailable dotenv parser as unknown without launching the CLI', async () => {
    const parser = vi.spyOn(util, 'parseEnv').mockImplementationOnce(() => {
      throw new TypeError('parser unavailable');
    });
    try {
      const { result, handshake } = await status({ DEEPSEEK_API_KEY: 'configured-placeholder' });
      expect(result.status).toBe('unknown');
      expect(handshake).not.toHaveBeenCalled();
    } finally {
      parser.mockRestore();
    }
  });
});

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createDeepseekHarnessAdapter({ binaryPath: '/custom/dsh' });
  adapters.push(adapter);
  const recorder = new EventRecorder(adapter);
  await adapter.startSession({
    sessionId: 's',
    cwd,
    env: {},
    runtimeMode: 'approval-required',
    mcpServers: {},
    connectorMcpServers: [],
    ...overrides,
  });
  return { adapter, recorder, server: servers.at(-1)! };
}

function permission(server: FakeAppServer, id = 81, callId = 'tool') {
  server.send({
    id,
    method: 'session/request_permission',
    params: {
      sessionId: 'native',
      toolCall: { toolCallId: callId },
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
    },
  });
}

describe('official ACP wire contract', () => {
  it('uses the official profile and applies an opaque selected model before prompting', async () => {
    const { adapter, server } = await start({
      model: { id: MODEL },
      systemContext: 'room context',
    });
    expect(launches).toEqual([{ command: '/custom/dsh', args: ['--profile', 'acp'] }]);
    expect(await adapter.listModels('s')).toMatchObject([{ id: MODEL, label: 'DeepSeek V4 Pro' }]);
    server.reply('session/prompt', { stopReason: 'end_turn' });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'answer the mention' });
    const prompt = await server.waitFor('session/prompt');
    expect(prompt.params?.prompt).toEqual([
      { type: 'text', text: 'room context\n\nanswer the mention' },
    ]);
    expect(server.received.map((message) => message.method)).toEqual([
      'initialize',
      'session/new',
      'session/set_config_option',
      'session/prompt',
    ]);
    expect(server.received[2]?.params).toEqual({
      sessionId: 'native',
      configId: 'model',
      value: MODEL,
    });
    await expect(adapter.setModel('s', { id: 'invented' })).rejects.toThrow('Unavailable model');
  });

  it.each(['accept', 'decline'] as const)(
    'forwards %s as a one-shot permission decision',
    async (decision) => {
      const { adapter, recorder, server } = await start();
      await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run a tool' });
      permission(server);
      const request = await recorder.waitFor('request.opened');
      expect(request.options.map((option) => option.decision)).toEqual([
        'accept',
        'decline',
        'cancel',
      ]);
      await adapter.respondToRequest('s', request.requestId, decision);
      await vi.waitFor(() =>
        expect(server.received.find((message) => message.id === 81)?.result).toEqual({
          outcome: {
            outcome: 'selected',
            optionId: decision === 'accept' ? 'allow-once' : 'reject-once',
          },
        })
      );
    }
  );

  it('auto-approves full access using allow_once only', async () => {
    const { adapter, server } = await start({ runtimeMode: 'full-access' });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'run a tool' });
    permission(server);
    await vi.waitFor(() =>
      expect(server.received.find((message) => message.id === 81)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      })
    );
  });

  it('recognizes registered room tools but still asks for connector tools', async () => {
    const { adapter, recorder, server } = await start({
      mcpServers: {
        room: { transport: 'http', url: 'https://room.example/mcp' },
        connector: { transport: 'http', url: 'https://connector.example/mcp' },
      },
      connectorMcpServers: ['connector'],
    });
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'read and reply to the room' });
    for (const name of ['room', 'connector']) {
      server.notify('session/update', {
        sessionId: 'native',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: name,
          title: `mcp__${name}__reply`,
          kind: 'other',
          status: 'in_progress',
        },
      });
      permission(server, name === 'room' ? 81 : 82, name);
    }
    const request = await recorder.waitFor('request.opened');
    expect(request.connector).toBe('connector');
    await vi.waitFor(() =>
      expect(server.received.find((message) => message.id === 81)?.result).toEqual({
        outcome: { outcome: 'selected', optionId: 'allow-once' },
      })
    );
    expect(server.received.find((message) => message.id === 82)).toBeUndefined();
  });

  it('does not infer an MCP server from an ambiguous or foreign namespace', () => {
    const identify = deepseekHarnessAcp.mcpServerOf!;
    expect(
      identify(
        { toolCallId: 'x', title: 'mcp__room__evil__reply' },
        new Set(['room', 'room__evil'])
      )
    ).toBeUndefined();
    expect(
      identify({ toolCallId: 'x', title: 'mcp__foreign__reply' }, new Set(['room']))
    ).toBeUndefined();
    expect(identify({ toolCallId: 'x', title: 'mcp__room__reply' }, new Set(['room']))).toBe(
      'room'
    );
  });

  it('matches normalized MCP names and refuses collisions with literal registered names', () => {
    const identify = deepseekHarnessAcp.mcpServerOf!;
    const call = { toolCallId: 'x', title: 'mcp__Room_tools_ed4cadef__switch_echo' };
    expect(identify(call, new Set(['Room tools!']))).toBe('Room tools!');
    expect(identify(call, new Set(['Room tools!', 'Room_tools_ed4cadef']))).toBeUndefined();
  });

  it('projects DSH generic bash and edit updates into activity items and room replies', async () => {
    const { adapter, recorder, server } = await start();
    await adapter.sendTurn({ sessionId: 's', turnId: 't', text: 'do the work' });
    for (const title of ['bash', 'write', 'edit', 'apply_patch']) {
      server.notify('session/update', {
        sessionId: 'native',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: title,
          title,
          kind: 'other',
          status: 'in_progress',
        },
      });
      server.notify('session/update', {
        sessionId: 'native',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: title,
          status: 'completed',
          content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
        },
      });
    }
    server.notify('session/update', {
      sessionId: 'native',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'room response' },
      },
    });
    const pending = await server.waitFor('session/prompt');
    server.send({ id: pending.id, result: { stopReason: 'end_turn' } });
    await recorder.waitFor('turn.completed');
    expect(recorder.ofType('item.completed').map((event) => event.item.type)).toEqual([
      'command_execution',
      'file_change',
      'file_change',
      'file_change',
      'assistant_message',
    ]);
    expect(recorder.assistantText('t')).toBe('room response');
  });

  it('queues mid-turn messages and cancels a running prompt and pending permission', async () => {
    const { adapter, recorder, server } = await start();
    await adapter.sendTurn({ sessionId: 's', turnId: 'first', text: 'first' });
    await adapter.sendTurn({ sessionId: 's', turnId: 'second', text: 'second' });
    expect(server.received.filter((message) => message.method === 'session/prompt')).toHaveLength(
      1
    );
    permission(server);
    await recorder.waitFor('request.opened');
    await adapter.interruptTurn('s');
    expect((await server.waitFor('session/cancel')).params).toEqual({ sessionId: 'native' });
    const first = await server.waitFor('session/prompt');
    server.reply('session/prompt', { stopReason: 'end_turn' });
    server.send({ id: first.id, result: { stopReason: 'cancelled' } });
    await recorder.waitFor('turn.completed', (event) => event.turnId === 'second');
    expect(recorder.ofType('turn.completed').map((event) => [event.turnId, event.outcome])).toEqual(
      [
        ['first', 'interrupted'],
        ['second', 'completed'],
      ]
    );
    expect(server.received.find((message) => message.id === 81)?.result).toEqual({
      outcome: { outcome: 'cancelled' },
    });
  });

  it('resumes after adapter restart through advertised session/resume without replay', async () => {
    const first = await start();
    await first.adapter.stopAll();
    const { server } = await start({ resume: { nativeSessionId: 'native' } });
    expect(server.received.map((message) => message.method)).toEqual([
      'initialize',
      'session/resume',
    ]);
    expect(server.received[1]?.params).toMatchObject({ sessionId: 'native', cwd });
  });
});
