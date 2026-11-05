import { readFileSync, existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ProviderConversationUnavailableError,
  type ProviderSessionStartInput,
  type RuntimeMode,
} from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { FakePi, type FakePiCommand } from './fake-pi';
import {
  APPROVAL_OPTIONS,
  encodeDialog,
  SWITCH_EXTENSION_COMMAND,
  SWITCH_EXTENSION_CONFIG_ENV,
  type SwitchDialog,
} from './protocol';

interface Spawn {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  /** The settings file as it was when Pi started, which Pi reads then. */
  config: Record<string, unknown> | undefined;
  extensionExisted: boolean;
}

const processes: FakePi[] = [];
const spawns: Spawn[] = [];
/** What the fake Pi answers; each test shapes it before starting a session. */
const pi = {
  extensionLoads: true,
  sessionFile: '' as string | undefined,
  model: { id: 'sonnet', provider: 'anthropic', input: ['text', 'image'] } as Record<
    string,
    unknown
  >,
  models: [] as Array<Record<string, unknown>>,
  disposition: 'started',
  /** Runs while the fake Pi answers `get_state`, to let a test stream something first. */
  duringStart: undefined as ((process: FakePi) => void | Promise<void>) | undefined,
  /** When set, `prompt` is answered only once this settles. */
  holdPrompt: undefined as Promise<void> | undefined,
  promptError: undefined as string | undefined,
};
vi.mock('node:child_process', () => ({
  spawn: (
    command: string,
    args: string[],
    options: { cwd: string; env: Record<string, string> }
  ) => {
    const configPath = options.env[SWITCH_EXTENSION_CONFIG_ENV];
    const extensionPath = args[args.indexOf('-e') + 1];
    spawns.push({
      command,
      args,
      cwd: options.cwd,
      env: options.env,
      config: configPath ? JSON.parse(readFileSync(configPath, 'utf8')) : undefined,
      extensionExisted: extensionPath ? existsSync(extensionPath) : false,
    });
    const process = new FakePi();
    process.answer('get_state', async () => {
      await pi.duringStart?.(process);
      return {
        model: pi.model,
        isStreaming: false,
        sessionId: 'pi-session',
        ...(pi.sessionFile ? { sessionFile: pi.sessionFile } : {}),
      };
    });
    process.answer('get_commands', () => ({
      commands: pi.extensionLoads
        ? [
            { name: 'mcp', source: 'extension' },
            { name: SWITCH_EXTENSION_COMMAND, source: 'extension' },
          ]
        : [{ name: 'mcp', source: 'extension' }],
    }));
    process.answer('get_available_models', () => ({ models: pi.models }));
    process.answer('set_model', {});
    process.answer('abort');
    process.on('record', (command: FakePiCommand) => {
      if (command.type !== 'prompt') return;
      void (pi.holdPrompt ?? Promise.resolve()).then(() =>
        process.send(
          pi.promptError
            ? {
                type: 'response',
                command: 'prompt',
                id: command.id,
                success: false,
                error: pi.promptError,
              }
            : {
                type: 'response',
                command: 'prompt',
                id: command.id,
                success: true,
                data: { disposition: pi.disposition },
              }
        )
      );
    });
    processes.push(process);
    return process;
  },
}));
const { createPiAdapter } = await import('./pi-adapter');

const MODELS = [
  { id: 'sonnet', name: 'Claude Sonnet', provider: 'anthropic', input: ['text', 'image'] },
  { id: 'qwen', name: 'Qwen', provider: 'ollama', input: ['text'] },
];

let work: string;
let sessionFiles: string;
beforeEach(async () => {
  processes.length = 0;
  spawns.length = 0;
  work = await mkdtemp(join(tmpdir(), 'pi-adapter-test-'));
  sessionFiles = join(work, 'sessions');
  Object.assign(pi, {
    extensionLoads: true,
    sessionFile: join(sessionFiles, 'one.jsonl'),
    model: { id: 'sonnet', provider: 'anthropic', input: ['text', 'image'] },
    models: MODELS,
    disposition: 'started',
    duringStart: undefined,
    holdPrompt: undefined,
    promptError: undefined,
  });
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

async function start(overrides: Partial<ProviderSessionStartInput> = {}) {
  const adapter = createPiAdapter();
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const session = await adapter.startSession({
    sessionId: 's',
    cwd: work,
    runtimeMode: 'approval-required',
    env: { HOME: '/home/u' },
    mcpServers: {},
    connectorMcpServers: [],
    ...overrides,
  });
  return { adapter, events, session, process: processes.at(-1)! };
}

function of<T extends ProviderRuntimeEventType>(events: ProviderRuntimeEvent[], type: T) {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

/** Starts a turn and waits until its prompt has reached Pi. */
async function turn(
  context: Awaited<ReturnType<typeof start>>,
  turnId = 't1',
  text = 'hello',
  extra: Record<string, unknown> = {}
) {
  const prompts = context.process.commands('prompt').length;
  await context.adapter.sendTurn({ sessionId: 's', turnId, text, ...extra });
  await vi.waitFor(() => expect(context.process.commands('prompt')).toHaveLength(prompts + 1));
  await flush();
}

const settle = (process: FakePi, aborted = false) =>
  process.event({ type: 'agent_settled', aborted });

function assistantMessage(
  process: FakePi,
  text: string,
  extra: Record<string, unknown> = {},
  deltas: string[] = [text]
) {
  process.event({ type: 'message_start', message: { role: 'assistant', content: [] } });
  for (const delta of deltas)
    process.event({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta },
    });
  process.event({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      stopReason: 'stop',
      provider: 'anthropic',
      model: 'sonnet',
      usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1 },
      ...extra,
    },
  });
}

function approval(
  process: FakePi,
  dialog: Partial<SwitchDialog> & { toolName: string },
  id = 'u1'
) {
  process.uiRequest({
    id,
    method: 'select',
    title: encodeDialog({ kind: 'approval', toolCallId: 'c1', ...dialog } as SwitchDialog),
    options: [...APPROVAL_OPTIONS],
  });
}

function toolStart(process: FakePi, toolName: string, args: Record<string, unknown>, id = 'c1') {
  process.event({ type: 'tool_execution_start', toolCallId: id, toolName, args });
}

describe('starting a session', () => {
  it('runs Pi in RPC mode in the session directory with Switch extension and nothing of Switch in its environment', async () => {
    const { session } = await start({ env: { HOME: '/home/u', PATH: '/bin' } });
    expect(session).toEqual({
      provider: 'pi',
      sessionId: 's',
      nativeSessionId: join(sessionFiles, 'one.jsonl'),
    });
    const [spawn] = spawns;
    expect(spawn!.command).toBe('pi');
    expect(spawn!.args).toEqual([
      '--mode',
      'rpc',
      '-e',
      expect.stringMatching(/switch-extension\.mjs$/),
    ]);
    expect(spawn!.cwd).toBe(work);
    expect(spawn!.env).toEqual({
      HOME: '/home/u',
      PATH: '/bin',
      PI_SKIP_VERSION_CHECK: '1',
      [SWITCH_EXTENSION_CONFIG_ENV]: expect.stringMatching(/config\.json$/),
    });
    expect(spawn!.extensionExisted).toBe(true);
  });

  it('runs the executable it is given', async () => {
    const adapter = createPiAdapter({ binaryPath: '/opt/pi/bin/pi' });
    await adapter.startSession({
      sessionId: 's',
      cwd: work,
      runtimeMode: 'full-access',
      env: {},
      mcpServers: {},
      connectorMcpServers: [],
    });
    expect(spawns[0]!.command).toBe('/opt/pi/bin/pi');
  });

  it('asks Pi for its state, commands and models, and tells the room once it is ready', async () => {
    const { events, process } = await start();
    expect(process.received.map((command) => command.type)).toEqual([
      'get_state',
      'get_commands',
      'get_available_models',
    ]);
    expect(events.map((event) => event.type)).toEqual([
      'session.state.changed',
      'session.started',
      'session.state.changed',
    ]);
    expect(of(events, 'session.started')[0]!.nativeSessionId).toBe(join(sessionFiles, 'one.jsonl'));
  });

  it("gives the extension the session's servers, their environment and the runtime mode, in a file only the host reads", async () => {
    await start({
      runtimeMode: 'auto-accept-edits',
      env: { HOME: '/home/u', SECRET: 'from-env' },
      mcpServers: {
        switch: {
          transport: 'http',
          url: 'http://127.0.0.1:7/mcp',
          headers: { Authorization: 'Bearer t$1' },
        },
        github: { transport: 'stdio', command: 'gh-mcp', args: ['serve'], envVars: ['SECRET'] },
      },
      connectorMcpServers: ['github'],
    });
    expect(spawns[0]!.config).toEqual({
      runtimeMode: 'auto-accept-edits',
      mcpServers: {
        switch: { url: 'http://127.0.0.1:7/mcp', headers: { Authorization: 'Bearer t$$1' } },
        github: { command: 'gh-mcp', args: ['serve'], env: { SECRET: 'from-env' } },
      },
      connectorMcpServers: ['github'],
    });
  });

  it('deletes those settings once Pi has read them, and the whole directory when the session ends', async () => {
    const { adapter } = await start();
    const config = spawns[0]!.env[SWITCH_EXTENSION_CONFIG_ENV]!;
    expect(existsSync(config)).toBe(false);
    expect(existsSync(spawns[0]!.args[3]!)).toBe(true);
    await adapter.stopSession('s');
    await vi.waitFor(() => expect(existsSync(dirname(config))).toBe(false));
  });

  it("adds the session's context to Pi's system prompt from a file", async () => {
    await start({ systemContext: 'You work for Switch.' });
    const args = spawns[0]!.args;
    expect(args.slice(4, 5)).toEqual(['--append-system-prompt']);
    expect(readFileSync(args[5]!, 'utf8')).toBe('You work for Switch.');
  });

  it('passes no system prompt when there is no context', async () => {
    await start();
    expect(spawns[0]!.args).not.toContain('--append-system-prompt');
  });

  it('resumes from the session file it named', async () => {
    const saved = join(work, 'saved.jsonl');
    await writeFile(saved, '');
    const { session } = await start({ resume: { nativeSessionId: saved } });
    expect(spawns[0]!.args.slice(-2)).toEqual(['--session', saved]);
    expect(session.nativeSessionId).toBe(join(sessionFiles, 'one.jsonl'));
  });

  it('asks the host to start a fresh conversation when the saved one is gone, rather than let Pi start one at that path', async () => {
    await expect(
      start({ resume: { nativeSessionId: join(work, 'gone.jsonl') } })
    ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(spawns).toEqual([]);
  });

  it('refuses a session id that is running', async () => {
    const { adapter } = await start();
    await expect(
      adapter.startSession({
        sessionId: 's',
        cwd: work,
        runtimeMode: 'full-access',
        env: {},
        mcpServers: {},
        connectorMcpServers: [],
      })
    ).rejects.toThrow('session already started');
  });

  it('does not start a session whose extension did not load, since it would have no Switch tools and no approvals', async () => {
    pi.extensionLoads = false;
    pi.duringStart = (process) =>
      process.event({
        type: 'extension_error',
        extensionPath: '/tmp/switch-extension.mjs',
        error: 'Invalid server name',
      });
    const adapter = createPiAdapter();
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const failure = adapter
      .startSession({
        sessionId: 's',
        cwd: work,
        runtimeMode: 'full-access',
        env: {},
        mcpServers: {},
        connectorMcpServers: [],
      })
      .catch((error: unknown) => error);
    expect(String(await failure)).toContain(
      'Could not start Pi: Error: Pi did not load the Switch extension, so the session would have no Switch tools and no approvals: /tmp/switch-extension.mjs failed: Invalid server name'
    );
    expect(adapter.hasSession('s')).toBe(false);
    expect(processes[0]!.killed).toContain('SIGTERM');
    expect(of(events, 'session.started')).toEqual([]);
    expect(existsSync(dirname(spawns[0]!.env[SWITCH_EXTENSION_CONFIG_ENV]!))).toBe(false);
  });

  it('does not start a session Pi gave no file to resume from', async () => {
    pi.sessionFile = undefined;
    await expect(start()).rejects.toThrow('Pi did not name a session file');
  });

  it('quotes what Pi said when it died while starting', async () => {
    pi.duringStart = async (process) => {
      process.stderr.write('Cannot find module');
      await flush();
      process.crash();
    };
    await expect(start()).rejects.toThrow('Cannot find module');
  });
});

describe('models', () => {
  it('lists the models Pi can use as provider/id, with what each takes as input', async () => {
    const { adapter } = await start();
    expect(await adapter.listModels('s')).toEqual([
      { id: 'anthropic/sonnet', label: 'Claude Sonnet (anthropic)', options: {}, imageInput: true },
      { id: 'ollama/qwen', label: 'Qwen (ollama)', options: {}, imageInput: false },
    ]);
  });

  it('lists none for a Pi nothing is signed in to', async () => {
    pi.models = [];
    const { adapter } = await start();
    expect(await adapter.listModels('s')).toEqual([]);
  });

  it('switches to the model it is started with, and makes sure Pi did', async () => {
    const { process } = await start({ model: { id: 'ollama/qwen' } });
    expect(process.commands('set_model')).toMatchObject([{ provider: 'ollama', modelId: 'qwen' }]);
  });

  it('does not switch to the model Pi is on already', async () => {
    const { process } = await start({ model: { id: 'anthropic/sonnet' } });
    expect(process.commands('set_model')).toEqual([]);
  });

  it('refuses a model Pi does not offer, and does not start', async () => {
    await expect(start({ model: { id: 'anthropic/gone' } })).rejects.toThrow(
      'Unavailable model: anthropic/gone'
    );
    expect(processes[0]!.killed).toContain('SIGTERM');
  });

  it('switches model for a turn that asks for one, and in the session', async () => {
    const context = await start();
    await context.adapter.setModel('s', { id: 'ollama/qwen' });
    expect(context.process.commands('set_model')).toHaveLength(1);
    await turn(context, 't1', 'hi', { model: { id: 'anthropic/sonnet' } });
    expect(context.process.commands('set_model')).toHaveLength(2);
    expect(context.process.commands('set_model')[1]).toMatchObject({
      provider: 'anthropic',
      modelId: 'sonnet',
    });
  });

  it('knows no model when Pi has none selected', async () => {
    pi.model = { id: 'unknown', provider: 'unknown' };
    const { adapter, process } = await start({ model: { id: 'anthropic/sonnet' } });
    expect(process.commands('set_model')).toHaveLength(1);
    expect(adapter.hasSession('s')).toBe(true);
  });
});

describe('a turn', () => {
  it('sends the message and reports the answer as it streams, until Pi is settled', async () => {
    const context = await start();
    const { events, process } = context;
    await turn(context, 't1', 'What is 2+2?');
    expect(process.commands('prompt')[0]).toMatchObject({ message: 'What is 2+2?' });
    assistantMessage(process, 'Four.', {}, ['Fo', 'ur.']);
    settle(process);
    await vi.waitFor(() => expect(of(events, 'turn.completed')).toHaveLength(1));
    const types = events.map((event) => event.type);
    expect(types.slice(3)).toEqual([
      'turn.started',
      'session.state.changed',
      'item.started',
      'content.delta',
      'content.delta',
      'item.completed',
      'turn.completed',
      'session.state.changed',
    ]);
    expect(of(events, 'content.delta').map((event) => event.delta)).toEqual(['Fo', 'ur.']);
    const completed = of(events, 'item.completed')[0]!.item;
    expect(completed).toMatchObject({
      type: 'assistant_message',
      status: 'completed',
      text: 'Four.',
    });
    expect(completed.id).toBe(of(events, 'item.started')[0]!.item.id);
    expect(of(events, 'turn.completed')[0]).toMatchObject({
      turnId: 't1',
      outcome: 'completed',
      usage: [
        {
          model: 'anthropic/sonnet',
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      ],
    });
  });

  it('is over at agent_settled, not at agent_end, for Pi may still retry or go on', async () => {
    const context = await start();
    await turn(context);
    context.process.event({ type: 'agent_end', willRetry: true });
    await flush();
    expect(of(context.events, 'turn.completed')).toEqual([]);
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
  });

  it('keeps the usage of each model apart and adds up a turn with several responses', async () => {
    const context = await start();
    await turn(context);
    assistantMessage(context.process, 'a');
    assistantMessage(context.process, 'b');
    assistantMessage(context.process, 'c', { provider: 'ollama', model: 'qwen' });
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]!.usage).toEqual([
      {
        model: 'anthropic/sonnet',
        inputTokens: 20,
        outputTokens: 8,
        cacheReadTokens: 4,
        cacheWriteTokens: 2,
      },
      {
        model: 'ollama/qwen',
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
      },
    ]);
  });

  it('shows an answer that was not streamed', async () => {
    const context = await start();
    await turn(context);
    context.process.event({ type: 'message_start', message: { role: 'assistant' } });
    context.process.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'all at once' }],
        stopReason: 'stop',
      },
    });
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'item.started').map((event) => event.item.type)).toEqual([
      'assistant_message',
    ]);
    expect(of(context.events, 'item.completed')[0]!.item.text).toBe('all at once');
  });

  it('ends in error, with Pi’s reason, when the model failed and Pi gave up', async () => {
    const context = await start();
    await turn(context);
    context.process.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '401 invalid key',
      },
    });
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]).toMatchObject({
      outcome: 'error',
      message: '401 invalid key',
    });
    expect(of(context.events, 'session.state.changed').at(-1)!.status).toBe('error');
  });

  it('forgets a failure a retry got past', async () => {
    const context = await start();
    await turn(context);
    context.process.event({
      type: 'auto_retry_start',
      attempt: 1,
      maxAttempts: 3,
      errorMessage: '529 overloaded',
    });
    context.process.event({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '529 overloaded',
      },
    });
    assistantMessage(context.process, 'recovered');
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]!.outcome).toBe('completed');
    expect(of(context.events, 'runtime.warning')[0]!.message).toBe(
      'Pi is retrying (1 of 3): 529 overloaded'
    );
  });

  it('ends in error when retrying ran out', async () => {
    const context = await start();
    await turn(context);
    context.process.event({
      type: 'auto_retry_end',
      success: false,
      finalError: 'Connection error.',
    });
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]).toMatchObject({
      outcome: 'error',
      message: 'Connection error.',
    });
  });

  it('ends in error when Pi refuses the prompt', async () => {
    pi.promptError = 'No API key found for the selected model';
    const context = await start();
    await context.adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'hi' });
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]).toMatchObject({
      outcome: 'error',
      message: 'No API key found for the selected model',
    });
  });

  it('ends at once for a prompt an extension command took, since no run follows', async () => {
    pi.disposition = 'handled';
    const context = await start();
    await context.adapter.sendTurn({ sessionId: 's', turnId: 't1', text: '/mcp' });
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]!.outcome).toBe('completed');
  });

  it('ignores what Pi says outside a turn', async () => {
    const { events, process } = await start();
    const before = events.length;
    assistantMessage(process, 'unprompted');
    toolStart(process, 'bash', { command: 'ls' });
    settle(process);
    await flush();
    expect(events).toHaveLength(before);
  });

  it('queues a message sent mid-turn, and gives it a turn of its own once the first is over', async () => {
    const context = await start();
    await turn(context, 't1');
    expect(
      await context.adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'second' })
    ).toEqual({
      turnId: 't2',
    });
    await flush();
    expect(context.process.commands('prompt')).toHaveLength(1);
    settle(context.process);
    await vi.waitFor(() => expect(context.process.commands('prompt')).toHaveLength(2));
    expect(context.process.commands('prompt')[1]).toMatchObject({ message: 'second' });
    expect(of(context.events, 'turn.completed').map((event) => event.turnId)).toEqual(['t1']);
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(2));
    expect(of(context.events, 'turn.started').map((event) => event.turnId)).toEqual(['t1', 't2']);
  });

  it('declares no steering, since the host queues messages and Pi gets one turn at a time', async () => {
    const { adapter } = await start();
    expect(adapter.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: true,
    });
  });
});

describe('attachments', () => {
  it('sends an image to a model that takes images, as Pi’s images', async () => {
    const context = await start();
    const image = join(work, 'shot.png');
    await writeFile(image, 'PNG-BYTES');
    await turn(context, 't1', 'look', { attachments: [{ path: image, mimeType: 'image/png' }] });
    expect(context.process.commands('prompt')[0]).toMatchObject({
      message: 'look',
      images: [
        { type: 'image', data: Buffer.from('PNG-BYTES').toString('base64'), mimeType: 'image/png' },
      ],
    });
  });

  it('names the file in the message when the model takes no images, and for any other kind of file', async () => {
    const context = await start({ model: { id: 'ollama/qwen' } });
    await turn(context, 't1', 'look', {
      attachments: [
        { path: '/tmp/shot.png', mimeType: 'image/png' },
        { path: '/tmp/notes.pdf', mimeType: 'application/pdf' },
      ],
    });
    const prompt = context.process.commands('prompt')[0]!;
    expect(prompt.message).toBe('look\n\nAttached files:\n/tmp/shot.png\n/tmp/notes.pdf');
    expect(prompt).not.toHaveProperty('images');
  });
});

describe('tools', () => {
  it('shows a command with its output', async () => {
    const context = await start();
    await turn(context);
    toolStart(context.process, 'bash', { command: 'ls -la' });
    context.process.event({
      type: 'tool_execution_update',
      toolCallId: 'c1',
      toolName: 'bash',
      args: { command: 'ls -la' },
      partialResult: { content: [{ type: 'text', text: 'partial' }] },
    });
    context.process.event({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'total 0' }] },
      isError: false,
    });
    await vi.waitFor(() => expect(of(context.events, 'item.completed')).toHaveLength(1));
    expect(
      context.events.filter((event) => event.type.startsWith('item.')).map((event) => event.type)
    ).toEqual(['item.started', 'item.updated', 'item.completed']);
    expect(of(context.events, 'item.updated')[0]!.item).toMatchObject({
      status: 'in_progress',
      text: 'partial',
    });
    expect(of(context.events, 'item.completed')[0]!.item).toEqual({
      id: 'c1',
      type: 'command_execution',
      status: 'completed',
      title: 'ls -la',
      toolName: 'bash',
      payload: { command: 'ls -la' },
      text: 'total 0',
    });
  });

  it.each([
    ['write', { path: 'a.txt', content: 'x' }, 'file_change', 'write a.txt'],
    ['edit', { path: 'a.txt', edits: [] }, 'file_change', 'edit a.txt'],
    ['read', { path: 'a.txt' }, 'tool_call', 'read a.txt'],
    ['grep', { pattern: 'TODO' }, 'tool_call', 'grep TODO'],
    ['ask_user', { question: 'Which?' }, 'tool_call', 'ask_user Which?'],
    ['mcp__switch__send_message', { text: 'hi' }, 'mcp_tool_call', 'switch: send_message'],
    ['unknown_tool', {}, 'tool_call', 'unknown_tool'],
  ])('shows %s as %s', async (toolName, args, type, title) => {
    const context = await start();
    await turn(context);
    toolStart(context.process, toolName, args);
    await vi.waitFor(() => expect(of(context.events, 'item.started')).toHaveLength(1));
    expect(of(context.events, 'item.started')[0]!.item).toMatchObject({
      type,
      title,
      status: 'in_progress',
    });
  });

  it('names the tool of an MCP server without its server', async () => {
    const context = await start();
    await turn(context);
    toolStart(context.process, 'mcp__github__create_issue', {});
    await vi.waitFor(() => expect(of(context.events, 'item.started')).toHaveLength(1));
    expect(of(context.events, 'item.started')[0]!.item.toolName).toBe('create_issue');
  });

  it('shows a tool that failed as failed', async () => {
    const context = await start();
    await turn(context);
    toolStart(context.process, 'bash', { command: 'false' });
    context.process.event({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'exit 1' }] },
      isError: true,
    });
    await vi.waitFor(() => expect(of(context.events, 'item.completed')).toHaveLength(1));
    expect(of(context.events, 'item.completed')[0]!.item).toMatchObject({
      status: 'failed',
      text: 'exit 1',
    });
  });

  it('fails a tool still running when the turn ends, and the turn with it', async () => {
    const context = await start();
    await turn(context);
    toolStart(context.process, 'bash', { command: 'sleep 9' });
    settle(context.process);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'item.completed')[0]!.item.status).toBe('failed');
    expect(of(context.events, 'turn.completed')[0]).toMatchObject({
      outcome: 'error',
      message: 'Pi ended the turn without confirming a pending tool result.',
    });
  });
});

describe('approvals', () => {
  it.each<
    [string, Parameters<typeof approval>[1], Record<string, unknown>, Record<string, unknown>]
  >([
    [
      'a command',
      { toolName: 'bash' },
      { command: 'rm -rf build' },
      { requestType: 'command_execution_approval', title: 'Run a command', detail: 'rm -rf build' },
    ],
    [
      'a file written',
      { toolName: 'write' },
      { path: 'src/a.ts', content: 'x' },
      { requestType: 'file_change_approval', title: 'Write a file', detail: 'src/a.ts' },
    ],
    [
      'a file edited',
      { toolName: 'edit' },
      { path: 'src/a.ts' },
      { requestType: 'file_change_approval', title: 'Edit a file', detail: 'src/a.ts' },
    ],
    [
      'a connector tool',
      { toolName: 'mcp__github__create_issue', server: 'github', connector: true },
      { title: 'Bug' },
      {
        requestType: 'mcp_tool_approval',
        title: 'github wants to run create_issue',
        detail: '{"title":"Bug"}',
        connector: 'github',
      },
    ],
    [
      'a tool of the person’s own MCP server',
      { toolName: 'mcp__theirs__run', server: 'theirs', connector: false },
      {},
      { requestType: 'mcp_tool_approval', title: 'theirs wants to run run' },
    ],
    [
      'any other tool',
      { toolName: 'deploy' },
      { env: 'prod' },
      { requestType: 'tool_approval', title: 'Use deploy', detail: '{"env":"prod"}' },
    ],
  ])('asks about %s', async (_name, dialog, args, expected) => {
    const context = await start();
    await turn(context);
    toolStart(context.process, dialog.toolName, args);
    approval(context.process, dialog);
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    const request = of(context.events, 'request.opened')[0]!;
    expect(request).toMatchObject({ turnId: 't1', requestId: 'u1', ...expected });
    expect(request.options).toEqual([
      { decision: 'accept', label: 'Allow once' },
      { decision: 'acceptForSession', label: 'Allow for this session' },
      { decision: 'decline', label: 'Reject' },
      { decision: 'cancel', label: 'Cancel' },
    ]);
    if (!('connector' in expected)) expect(request).not.toHaveProperty('connector');
  });

  it.each([
    ['accept', 'Allow once'],
    ['acceptForSession', 'Allow for this session'],
    ['decline', 'Reject'],
  ] as const)('answers %s with the choice the extension offered', async (decision, choice) => {
    const context = await start();
    await turn(context);
    approval(context.process, { toolName: 'bash' });
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    await context.adapter.respondToRequest('s', 'u1', decision);
    await vi.waitFor(() => expect(context.process.uiResponses()).toHaveLength(1));
    expect(context.process.uiResponses()[0]).toEqual({
      type: 'extension_ui_response',
      id: 'u1',
      value: choice,
    });
    expect(of(context.events, 'request.resolved')).toMatchObject([{ requestId: 'u1', decision }]);
  });

  it('cancels the dialog when the person cancels', async () => {
    const context = await start();
    await turn(context);
    approval(context.process, { toolName: 'bash' });
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    await context.adapter.respondToRequest('s', 'u1', 'cancel');
    await vi.waitFor(() => expect(context.process.uiResponses()).toHaveLength(1));
    expect(context.process.uiResponses()[0]).toEqual({
      type: 'extension_ui_response',
      id: 'u1',
      cancelled: true,
    });
  });

  it('shows the tool the person rejected as declined', async () => {
    const context = await start();
    await turn(context);
    toolStart(context.process, 'bash', { command: 'rm -rf /' });
    approval(context.process, { toolName: 'bash' });
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    await context.adapter.respondToRequest('s', 'u1', 'decline');
    context.process.event({
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'Denied by the user in Switch.' }] },
      isError: true,
    });
    await vi.waitFor(() => expect(of(context.events, 'item.completed')).toHaveLength(1));
    expect(of(context.events, 'item.completed')[0]!.item).toMatchObject({
      status: 'declined',
      text: 'Denied by the user in Switch.',
    });
  });

  it('refuses an answer to a request nobody is waiting on', async () => {
    const context = await start();
    await expect(context.adapter.respondToRequest('s', 'nope', 'accept')).rejects.toThrow(
      'No pending approval nope'
    );
  });

  it('cancels a dialog that arrives with no turn running, for nobody could answer it', async () => {
    const { events, process } = await start();
    approval(process, { toolName: 'bash' });
    await vi.waitFor(() => expect(process.uiResponses()).toHaveLength(1));
    expect(process.uiResponses()[0]).toEqual({
      type: 'extension_ui_response',
      id: 'u1',
      cancelled: true,
    });
    expect(of(events, 'request.opened')).toEqual([]);
  });

  it('takes a dialog that only looks like an approval for a question', async () => {
    const context = await start();
    await turn(context);
    context.process.uiRequest({
      id: 'u1',
      method: 'select',
      title: encodeDialog({ kind: 'approval', toolCallId: 'c1', toolName: 'bash' }),
      options: ['Yes', 'No'],
    });
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    expect(of(context.events, 'request.opened')).toEqual([]);
  });

  it.each<[RuntimeMode]>([['approval-required'], ['auto-accept-edits'], ['auto'], ['full-access']])(
    'leaves the mode %s to the extension, which has the settings',
    async (runtimeMode) => {
      await start({ runtimeMode });
      expect(spawns[0]!.config).toMatchObject({ runtimeMode });
    }
  );
});

describe('questions', () => {
  function ask(process: FakePi, dialog: Partial<Extract<SwitchDialog, { kind: 'question' }>> = {}) {
    process.uiRequest({
      id: 'q1',
      method: 'select',
      title: encodeDialog({
        kind: 'question',
        question: 'Which color?',
        multiSelect: false,
        ...dialog,
      }),
      options: ['red', 'green', 'blue'],
    });
  }

  it('shows the question ask_user asks with its choices, and answers with the one chosen', async () => {
    const context = await start();
    await turn(context);
    ask(context.process, { header: 'Color' });
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    expect(of(context.events, 'user-input.requested')[0]).toMatchObject({
      turnId: 't1',
      requestId: 'q1',
      questions: [
        {
          id: 'q1',
          header: 'Color',
          question: 'Which color?',
          options: [
            { label: 'red', value: 'red' },
            { label: 'green', value: 'green' },
            { label: 'blue', value: 'blue' },
          ],
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
    });
    await context.adapter.respondToUserInput('s', 'q1', { q1: 'green' });
    expect(context.process.uiResponses()).toEqual([
      { type: 'extension_ui_response', id: 'q1', value: 'green' },
    ]);
    expect(of(context.events, 'user-input.resolved')).toMatchObject([{ requestId: 'q1' }]);
  });

  it('answers a multiple choice with a JSON array', async () => {
    const context = await start();
    await turn(context);
    ask(context.process, { multiSelect: true });
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    await context.adapter.respondToUserInput('s', 'q1', { q1: ['red', 'blue'] });
    expect(context.process.uiResponses()[0]).toMatchObject({ value: '["red","blue"]' });
  });

  it.each([
    ['an answer that was not offered', { q1: 'purple' }],
    ['no answer', {}],
    ['two answers to a single choice', { q1: ['red', 'green'] }],
  ])('refuses %s, and the question stays open', async (_name, answers) => {
    const context = await start();
    await turn(context);
    ask(context.process);
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    await expect(context.adapter.respondToUserInput('s', 'q1', answers)).rejects.toThrow(
      'Invalid answer for q1'
    );
    expect(context.process.uiResponses()).toEqual([]);
    await context.adapter.respondToUserInput('s', 'q1', { q1: 'red' });
    expect(context.process.uiResponses()).toHaveLength(1);
  });

  it('shows any other extension’s select as a question of its own', async () => {
    const context = await start();
    await turn(context);
    context.process.uiRequest({
      id: 'q2',
      method: 'select',
      title: 'Pick a branch',
      options: ['main', 'dev'],
    });
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    expect(of(context.events, 'user-input.requested')[0]!.questions[0]).toMatchObject({
      question: 'Pick a branch',
      options: [
        { label: 'main', value: 'main' },
        { label: 'dev', value: 'dev' },
      ],
      allowCustomAnswer: false,
    });
  });

  it('shows an input or editor dialog as a question that takes text', async () => {
    const context = await start();
    await turn(context);
    context.process.uiRequest({ id: 'q3', method: 'input', title: 'Commit message' });
    await vi.waitFor(() => expect(of(context.events, 'user-input.requested')).toHaveLength(1));
    expect(of(context.events, 'user-input.requested')[0]!.questions[0]).toMatchObject({
      question: 'Commit message',
      options: [],
      allowCustomAnswer: true,
    });
    await context.adapter.respondToUserInput('s', 'q3', { q3: 'Fix the build' });
    expect(context.process.uiResponses()[0]).toEqual({
      type: 'extension_ui_response',
      id: 'q3',
      value: 'Fix the build',
    });
  });

  it('shows a confirm dialog as a decision', async () => {
    const context = await start();
    await turn(context);
    context.process.uiRequest({
      id: 'k1',
      method: 'confirm',
      title: 'Clear session?',
      message: 'All is lost.',
    });
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    expect(of(context.events, 'request.opened')[0]).toMatchObject({
      requestType: 'tool_approval',
      title: 'Clear session?',
      detail: 'All is lost.',
      options: [
        { decision: 'accept', label: 'Approve' },
        { decision: 'decline', label: 'Decline' },
        { decision: 'cancel', label: 'Cancel' },
      ],
    });
    await expect(context.adapter.respondToRequest('s', 'k1', 'acceptForSession')).rejects.toThrow(
      'not offered'
    );
    await context.adapter.respondToRequest('s', 'k1', 'decline');
    expect(context.process.uiResponses()[0]).toEqual({
      type: 'extension_ui_response',
      id: 'k1',
      confirmed: false,
    });
  });

  it('ignores the extension requests that expect no answer', async () => {
    const context = await start();
    await turn(context);
    for (const method of ['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text'])
      context.process.uiRequest({ id: method, method, message: 'hi' });
    await flush();
    expect(context.process.uiResponses()).toEqual([]);
    expect(of(context.events, 'request.opened')).toEqual([]);
  });

  it('refuses an answer to a question nobody asked', async () => {
    const { adapter } = await start();
    await expect(adapter.respondToUserInput('s', 'nope', {})).rejects.toThrow(
      'No pending question nope'
    );
  });
});

describe('interrupting', () => {
  it('stops Pi, cancels what waits for an answer, and ends the turn as interrupted', async () => {
    const context = await start();
    await turn(context);
    approval(context.process, { toolName: 'bash' });
    ask(context.process);
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    await context.adapter.interruptTurn('s');
    await vi.waitFor(() => expect(context.process.commands('abort')).toHaveLength(1));
    expect(context.process.uiResponses().map((response) => response.cancelled)).toEqual([
      true,
      true,
    ]);
    expect(of(context.events, 'request.resolved')).toMatchObject([
      { requestId: 'u1', decision: 'cancel' },
    ]);
    settle(context.process, true);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]).toMatchObject({
      outcome: 'interrupted',
      message: 'Interrupted.',
    });
    // The session takes the next message.
    await turn(context, 't2');
  });

  function ask(process: FakePi) {
    process.uiRequest({
      id: 'q1',
      method: 'select',
      title: encodeDialog({ kind: 'question', question: 'Which?', multiSelect: false }),
      options: ['a'],
    });
  }

  it('cancels a dialog Pi opens while the abort is on its way', async () => {
    const context = await start();
    await turn(context);
    await context.adapter.interruptTurn('s');
    approval(context.process, { toolName: 'bash' });
    await vi.waitFor(() => expect(context.process.uiResponses()).toHaveLength(1));
    expect(of(context.events, 'request.opened')).toEqual([]);
  });

  it('stops a run Pi starts after the interrupt, when the prompt was still on its way', async () => {
    let accept: () => void = () => {};
    pi.holdPrompt = new Promise<void>((resolve) => (accept = resolve));
    const context = await start();
    await context.adapter.sendTurn({ sessionId: 's', turnId: 't1', text: 'hi' });
    await vi.waitFor(() => expect(context.process.commands('prompt')).toHaveLength(1));
    await context.adapter.interruptTurn('s');
    await vi.waitFor(() => expect(context.process.commands('abort')).toHaveLength(1));
    accept();
    await vi.waitFor(() => expect(context.process.commands('abort')).toHaveLength(2));
  });

  it('does nothing when no turn is running', async () => {
    const { adapter, process } = await start();
    await adapter.interruptTurn('s');
    expect(process.commands('abort')).toEqual([]);
  });

  it('counts a turn it interrupted as interrupted, whatever Pi says when it settles', async () => {
    const context = await start();
    await turn(context);
    await context.adapter.interruptTurn('s');
    settle(context.process, false);
    await vi.waitFor(() => expect(of(context.events, 'turn.completed')).toHaveLength(1));
    expect(of(context.events, 'turn.completed')[0]!.outcome).toBe('interrupted');
  });
});

describe('the end of a session', () => {
  it('ends the running turn and the queued ones in error, and the session, when Pi dies', async () => {
    const context = await start();
    await turn(context, 't1');
    await context.adapter.sendTurn({ sessionId: 's', turnId: 't2', text: 'queued' });
    context.process.crash();
    await vi.waitFor(() => expect(of(context.events, 'session.exited')).toHaveLength(1));
    expect(
      of(context.events, 'turn.completed').map((event) => [event.turnId, event.outcome])
    ).toEqual([
      ['t1', 'error'],
      ['t2', 'error'],
    ]);
    expect(of(context.events, 'session.exited')[0]!.reason).toContain('provider process exited');
    expect(context.adapter.hasSession('s')).toBe(false);
    await expect(
      context.adapter.sendTurn({ sessionId: 's', turnId: 't3', text: 'x' })
    ).rejects.toThrow('Session is not running');
  });

  it('cancels what waits for an answer when Pi dies', async () => {
    const context = await start();
    await turn(context);
    approval(context.process, { toolName: 'bash' });
    await vi.waitFor(() => expect(of(context.events, 'request.opened')).toHaveLength(1));
    context.process.crash();
    await vi.waitFor(() => expect(of(context.events, 'request.resolved')).toHaveLength(1));
    expect(of(context.events, 'request.resolved')[0]!.decision).toBe('cancel');
  });

  it('stops the turn, the process and the session when told to, and removes its directory', async () => {
    const context = await start();
    const directory = dirname(spawns[0]!.env[SWITCH_EXTENSION_CONFIG_ENV]!);
    await turn(context);
    await context.adapter.stopSession('s');
    expect(context.process.commands('abort')).toHaveLength(1);
    expect(context.process.killed).toContain('SIGTERM');
    expect(of(context.events, 'turn.completed')[0]!.outcome).toBe('interrupted');
    expect(of(context.events, 'session.exited')).toHaveLength(1);
    expect(context.adapter.hasSession('s')).toBe(false);
    await vi.waitFor(() => expect(existsSync(directory)).toBe(false));
  });

  it('stops every session', async () => {
    const adapter = createPiAdapter();
    for (const sessionId of ['a', 'b'])
      await adapter.startSession({
        sessionId,
        cwd: work,
        runtimeMode: 'full-access',
        env: {},
        mcpServers: {},
        connectorMcpServers: [],
      });
    await adapter.stopAll();
    expect(adapter.hasSession('a') || adapter.hasSession('b')).toBe(false);
    expect(processes.every((process) => process.killed.includes('SIGTERM'))).toBe(true);
  });

  it('warns the room, rather than ending the session, when an extension fails after the start', async () => {
    const context = await start();
    context.process.event({
      type: 'extension_error',
      extensionPath: '/home/u/.pi/agent/extensions/theirs.ts',
      event: 'tool_call',
      error: 'boom',
    });
    await vi.waitFor(() => expect(of(context.events, 'runtime.warning')).toHaveLength(1));
    expect(of(context.events, 'runtime.warning')[0]!.message).toBe(
      '/home/u/.pi/agent/extensions/theirs.ts failed on tool_call: boom'
    );
    expect(context.adapter.hasSession('s')).toBe(true);
  });
});
