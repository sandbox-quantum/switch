import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderSessionStartInput, RuntimeMode } from '../adapter';
import type { ProviderRuntimeEvent, ProviderRuntimeEventType } from '../events';
import { AMP_PLUGIN_FILENAME } from './approval-plugin';
import { FakeAmp, FakePlugin } from './fake-amp';

const spawned: FakeAmp[] = [];
/** The `amp threads new` runs, as execProvider makes them, and what the next one answers. */
const executed: {
  command: string;
  args: string[];
  options: { cwd?: string; env?: Record<string, string> };
}[] = [];
const threadCreated = () =>
  Promise.resolve({ stdout: 'https://ampcode.com/threads/T-1\n', stderr: '' });
let createThread: () => Promise<{ stdout: string; stderr: string }> = threadCreated;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  const { promisify } = await import('node:util');
  const execFile = () => {
    throw new Error('execFile is doubled through promisify only');
  };
  Object.defineProperty(execFile, promisify.custom, {
    value: (
      command: string,
      args: string[],
      options: { cwd?: string; env?: Record<string, string> }
    ) => {
      executed.push({ command, args, options });
      return Object.assign(createThread(), { child: { stdin: { end() {} } } });
    },
  });
  return {
    ...actual,
    execFile,
    spawn: (
      command: string,
      args: string[],
      options: { cwd?: string; env?: Record<string, string> }
    ) => {
      const amp = new FakeAmp(command, args, options);
      spawned.push(amp);
      return amp;
    },
  };
});

const { ampPluginNotLoaded, createAmpAdapter } = await import('./amp-adapter');

type AmpAdapter = ReturnType<typeof createAmpAdapter>;

const TIMEOUTS = {
  initMs: 2_000,
  pluginReadyMs: 2_000,
  cancelMs: 2_000,
  endGraceMs: 2_000,
  decisionWaitMs: 5_000,
  controlWaitMs: 5_000,
};

function eventsOf<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  type: T
): Array<Extract<ProviderRuntimeEvent, { type: T }>> {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> => event.type === type
  );
}

function waitFor<T extends ProviderRuntimeEventType>(
  events: ProviderRuntimeEvent[],
  adapter: AmpAdapter,
  type: T,
  predicate: (event: Extract<ProviderRuntimeEvent, { type: T }>) => boolean = () => true,
  timeoutMs = 5_000
): Promise<Extract<ProviderRuntimeEvent, { type: T }>> {
  const existing = eventsOf(events, type).find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(
        new Error(`no ${type} within ${timeoutMs} ms; saw ${events.map((e) => e.type).join(' > ')}`)
      );
    }, timeoutMs);
    const unsubscribe = adapter.subscribe((event) => {
      if (event.type !== type) return;
      const typed = event as Extract<ProviderRuntimeEvent, { type: T }>;
      if (!predicate(typed)) return;
      clearTimeout(timer);
      unsubscribe();
      resolve(typed);
    });
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let home: string;
let adapters: AmpAdapter[] = [];

beforeEach(async () => {
  spawned.length = 0;
  executed.length = 0;
  createThread = threadCreated;
  home = await mkdtemp(join(tmpdir(), 'amp-test-home-'));
  await mkdir(join(home, '.config', 'amp'), { recursive: true });
  await writeFile(
    join(home, '.config', 'amp', 'settings.json'),
    JSON.stringify({
      'amp.showCosts': false,
      'amp.mcpServers': { linear: { url: 'https://l/sse' } },
    })
  );
});

afterEach(async () => {
  await Promise.all(adapters.map((adapter) => adapter.stopAll()));
  adapters = [];
  await rm(home, { recursive: true, force: true });
});

function startInput(overrides: Partial<ProviderSessionStartInput> = {}): ProviderSessionStartInput {
  return {
    sessionId: 'session-1',
    cwd: '/work',
    runtimeMode: 'approval-required',
    env: { PATH: '/usr/bin', HOME: home },
    mcpServers: {
      switch: {
        transport: 'http',
        url: 'http://127.0.0.1:9/mcp',
        headers: { authorization: 'Bearer t' },
      },
    },
    connectorMcpServers: [],
    model: { id: 'high' },
    systemContext: 'You are in a Switch room.',
    ...overrides,
  };
}

/** Starts a session, answering as Amp and its plugin would, and returns everything a test drives. */
async function start(
  overrides: Partial<ProviderSessionStartInput> = {},
  options: { plugin?: boolean } = {}
) {
  const adapter = createAmpAdapter({ sessionsRoot: join(home, 'sessions'), timeouts: TIMEOUTS });
  adapters.push(adapter);
  const events: ProviderRuntimeEvent[] = [];
  adapter.subscribe((event) => events.push(event));
  const input = startInput(overrides);
  const starting = adapter.startSession(input);
  await vi.waitFor(() => expect(spawned.length).toBeGreaterThan(0));
  const amp = spawned.at(-1)!;
  const plugin = new FakePlugin(amp);
  if (options.plugin ?? true) await plugin.ready();
  const session = await starting;
  return { adapter, events, amp, plugin, session, input };
}

/** One complete turn: the message in, the echo, one assistant message, and the plugin's `agent.end`. */
async function completeTurn(
  ctx: Awaited<ReturnType<typeof start>>,
  turnId: string,
  reply: string,
  options: { plugin?: boolean } = {}
) {
  const sent = ctx.amp.received.length;
  const result = await ctx.adapter.sendTurn({
    sessionId: ctx.input.sessionId,
    turnId,
    text: `say ${reply}`,
  });
  const written = ctx.amp.received[sent]!;
  const text = (written.message as { content: { text: string }[] }).content[0]!.text;
  ctx.amp.echoUser(text);
  if (options.plugin ?? true) await ctx.plugin.agentStart(text);
  ctx.amp.assistant([{ type: 'text', text: reply }], 'end_turn', {
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 10,
      output_tokens: 3,
      cache_read_input_tokens: 5,
      cache_creation_input_tokens: 2,
      max_tokens: 968000,
    },
  });
  if (options.plugin ?? true) await ctx.plugin.agentEnd('done');
  return result;
}

describe('AmpAdapter start', () => {
  it('creates the thread, continues it in execute mode with the session’s settings file and plugin, and reports it', async () => {
    const { amp, session, events } = await start();
    expect(amp.command).toBe('amp');
    expect(amp.args).toEqual([
      'threads',
      'continue',
      'T-1',
      '--mode',
      'high',
      '--visibility',
      'private',
      '--no-archive-after-execute',
      '--settings-file',
      expect.stringContaining('settings.json'),
      '--plugin-ready-timeout',
      '60',
      '--stream-json',
      '--stream-json-input',
      '--execute',
    ]);
    expect(executed).toHaveLength(1);
    expect(executed[0]!.args).toEqual([
      'threads',
      'new',
      '--visibility',
      'private',
      '--settings-file',
      amp.args[amp.args.indexOf('--settings-file') + 1],
    ]);
    expect(executed[0]!.options.cwd).toBe('/work');
    expect(executed[0]!.options.env?.XDG_CONFIG_HOME).toBe(amp.env.XDG_CONFIG_HOME);
    expect(amp.received).toEqual([]);
    expect(amp.options.cwd).toBe('/work');
    expect(amp.env.PATH).toBe('/usr/bin');
    expect(amp.env.AMP_SKIP_UPDATE_CHECK).toBe('1');
    const configHome = amp.env.XDG_CONFIG_HOME!;
    expect(configHome.startsWith(join(home, 'sessions'))).toBe(true);
    await expect(
      stat(join(configHome, 'amp', 'plugins', AMP_PLUGIN_FILENAME))
    ).resolves.toBeDefined();
    const settings = JSON.parse(
      await readFile(amp.args[amp.args.indexOf('--settings-file') + 1]!, 'utf8')
    );
    expect(settings['amp.showCosts']).toBe(false);
    expect(settings['amp.mcpServers']).toEqual({
      linear: { url: 'https://l/sse' },
      switch: { url: 'http://127.0.0.1:9/mcp', headers: { authorization: 'Bearer t' } },
    });
    expect(session).toEqual({ sessionId: 'session-1', nativeSessionId: 'T-1', provider: 'amp' });
    expect(eventsOf(events, 'session.started')[0]?.nativeSessionId).toBe('T-1');
    expect(eventsOf(events, 'session.state.changed').map((e) => e.status)).toEqual([
      'starting',
      'ready',
    ]);
  });

  it('refuses to start outside full access when the plugin never loads, stopping amp', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, pluginReadyMs: 100 },
    });
    adapters.push(adapter);
    const starting = adapter.startSession(startInput());
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    await expect(starting).rejects.toThrow(ampPluginNotLoaded('approval-required'));
    await vi.waitFor(() => expect(spawned[0]!.killed ?? 'closed').toBeTruthy());
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('starts in full access without waiting for the plugin', async () => {
    const { session } = await start({ runtimeMode: 'full-access' }, { plugin: false });
    expect(session.nativeSessionId).toBe('T-1');
  });

  it('fails loudly when amp exits before its plugin calls in, with its stderr', async () => {
    const adapter = createAmpAdapter({ sessionsRoot: join(home, 'sessions'), timeouts: TIMEOUTS });
    adapters.push(adapter);
    const starting = adapter.startSession(startInput());
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    spawned[0]!.stderr.write('Not logged in. Run amp login.\n');
    await tick();
    spawned[0]!.exit(1, null);
    await expect(starting).rejects.toThrow(/Not logged in/);
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('fails loudly when the thread cannot be created, starting no run', async () => {
    createThread = () =>
      Promise.reject(
        Object.assign(new Error('Command failed: amp threads new'), {
          stderr: 'Not logged in. Run amp login.\n',
        })
      );
    const adapter = createAmpAdapter({ sessionsRoot: join(home, 'sessions'), timeouts: TIMEOUTS });
    adapters.push(adapter);
    await expect(adapter.startSession(startInput())).rejects.toThrow(/Not logged in/);
    expect(spawned).toHaveLength(0);
    expect(adapter.hasSession('session-1')).toBe(false);
  });

  it('fails loudly when amp threads new prints no thread id', async () => {
    createThread = () => Promise.resolve({ stdout: 'Updating amp...\n', stderr: '' });
    const adapter = createAmpAdapter({ sessionsRoot: join(home, 'sessions'), timeouts: TIMEOUTS });
    adapters.push(adapter);
    await expect(adapter.startSession(startInput())).rejects.toThrow(
      /printed no thread id: Updating amp/
    );
    expect(spawned).toHaveLength(0);
  });

  it('continues a saved thread on resume, without sending the context again', async () => {
    const ctx = await start({ resume: { nativeSessionId: 'T-saved' } });
    expect(executed).toHaveLength(0);
    expect(ctx.amp.args.slice(0, 5)).toEqual([
      'threads',
      'continue',
      'T-saved',
      '--visibility',
      'private',
    ]);
    expect(ctx.amp.args).not.toContain('--mode');
    expect(ctx.session.nativeSessionId).toBe('T-saved');
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hello again' });
    const written = ctx.amp.received[0]!;
    expect((written.message as { content: { text: string }[] }).content[0]!.text).toBe(
      'hello again'
    );
  });

  it('warns when amp continues a different thread than asked', async () => {
    const ctx = await start(
      { resume: { nativeSessionId: 'T-saved' }, runtimeMode: 'full-access' },
      { plugin: false }
    );
    expect(ctx.session.nativeSessionId).toBe('T-saved');
    ctx.amp.threadId = 'T-other';
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    const warning = await waitFor(ctx.events, ctx.adapter, 'runtime.warning');
    expect(warning.message).toContain('T-other');
  });

  it('warns when Amp runs the thread in another mode than asked, and keeps the thread’s', async () => {
    const ctx = await start({ runtimeMode: 'full-access' }, { plugin: false });
    ctx.amp.agentMode = 'medium';
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    const warning = await waitFor(ctx.events, ctx.adapter, 'runtime.warning');
    expect(warning.message).toBe('Amp runs this thread in medium mode, not high.');
    await ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'again',
      model: { id: 'high' },
    });
    expect(eventsOf(ctx.events, 'runtime.warning').at(-1)?.message).toContain('stays on medium');
  });

  it('fails the turn loudly when amp never starts the thread, and tries again on the next turn', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, initMs: 100 },
    });
    adapters.push(adapter);
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const starting = adapter.startSession(startInput({ runtimeMode: 'full-access' }));
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    const amp = spawned[0]!;
    amp.silent = true;
    await starting;
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    const done = await waitFor(events, adapter, 'turn.completed');
    expect(done.outcome).toBe('error');
    expect(done.message).toMatch(/did not start the thread within 0.1 s/);
    expect(eventsOf(events, 'runtime.error')[0]?.message).toMatch(/did not start the thread/);
    expect(amp.killed).toBe('SIGTERM');
    expect(eventsOf(events, 'session.exited')).toHaveLength(0);
    const sending = adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-2', text: 'again' });
    await vi.waitFor(() => expect(spawned.length).toBe(2));
    await sending;
    expect(spawned[1]!.args.slice(0, 5)).toEqual(['threads', 'continue', 'T-1', '--mode', 'high']);
  });
});

describe('AmpAdapter turns', () => {
  it('runs a turn: the context goes with the first message, text streams, and agent.end closes it with usage', async () => {
    const ctx = await start();
    const result = await completeTurn(ctx, 'turn-1', 'hello');
    expect(result).toEqual({ turnId: 'turn-1' });
    const written = ctx.amp.received[0]!;
    expect(written).toEqual({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'You are in a Switch room.\n\nsay hello' }],
      },
    });
    const done = await waitFor(
      ctx.events,
      ctx.adapter,
      'turn.completed',
      (e) => e.turnId === 'turn-1'
    );
    expect(done.outcome).toBe('completed');
    expect(done.usage).toEqual([
      {
        model: 'claude-opus-5-5',
        inputTokens: 10,
        outputTokens: 3,
        cacheReadTokens: 5,
        cacheWriteTokens: 2,
      },
    ]);
    expect(eventsOf(ctx.events, 'turn.started').map((e) => e.turnId)).toEqual(['turn-1']);
    expect(eventsOf(ctx.events, 'content.delta').map((e) => e.delta)).toEqual(['hello']);
    const items = eventsOf(ctx.events, 'item.completed');
    expect(items.map((e) => [e.item.type, e.item.text])).toEqual([['assistant_message', 'hello']]);
    expect(await ctx.adapter.contextUsage('session-1')).toEqual({
      usedTokens: 20,
      windowTokens: 968000,
    });

    // The context is not sent twice.
    await completeTurn(ctx, 'turn-2', 'again');
    const second = ctx.amp.received[1]!;
    expect((second.message as { content: { text: string }[] }).content[0]!.text).toBe('say again');
    expect(eventsOf(ctx.events, 'turn.completed')).toHaveLength(2);
  });

  it('closes the turn after the grace period when the plugin does not report its end', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, endGraceMs: 100 },
    });
    adapters.push(adapter);
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const starting = adapter.startSession(startInput());
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    const amp = spawned[0]!;
    await new FakePlugin(amp).ready();
    await starting;
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    amp.assistant([{ type: 'text', text: 'done' }], 'end_turn');
    const done = await waitFor(events, adapter, 'turn.completed');
    expect(done.outcome).toBe('completed');
  });

  it('without the plugin, the model stopping ends the turn at once', async () => {
    const ctx = await start({ runtimeMode: 'full-access' }, { plugin: false });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    ctx.amp.assistant([{ type: 'text', text: 'done' }], 'end_turn');
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done.outcome).toBe('completed');
  });

  it('keeps a turn open while the model asks for tools, and completes their items from the results', async () => {
    const ctx = await start({ runtimeMode: 'full-access' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'list files' });
    ctx.amp.assistant(
      [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'ls' } }],
      'tool_use'
    );
    const started = await waitFor(
      ctx.events,
      ctx.adapter,
      'item.started',
      (e) => e.item.id === 'toolu_1'
    );
    expect(started.item).toMatchObject({
      type: 'command_execution',
      title: 'ls',
      status: 'in_progress',
      toolName: 'Bash',
    });
    expect(eventsOf(ctx.events, 'turn.completed')).toHaveLength(0);
    ctx.amp.toolResult('toolu_1', 'a.txt\nb.txt');
    const finished = await waitFor(
      ctx.events,
      ctx.adapter,
      'item.completed',
      (e) => e.item.id === 'toolu_1'
    );
    expect(finished.item).toMatchObject({ status: 'completed', text: 'a.txt\nb.txt' });
    ctx.amp.assistant([{ type: 'text', text: 'two files' }], 'end_turn');
    await ctx.plugin.agentEnd('done');
    await waitFor(ctx.events, ctx.adapter, 'turn.completed');
  });

  it('sends a mid-turn message steered, and settles it at once when Amp takes it up in the running turn', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    ctx.amp.echoUser('You are in a Switch room.\n\ncount');
    const steered = await ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'stop',
    });
    expect(steered).toEqual({ turnId: 'turn-2' });
    expect(ctx.amp.received[1]).toEqual({
      type: 'user',
      steer: true,
      message: { role: 'user', content: [{ type: 'text', text: 'stop' }] },
    });
    ctx.amp.echoUser('stop');
    await tick();
    expect(eventsOf(ctx.events, 'turn.started').map((e) => e.turnId)).toEqual(['turn-1', 'turn-2']);
    expect(eventsOf(ctx.events, 'turn.completed')).toEqual([
      expect.objectContaining({
        turnId: 'turn-2',
        outcome: 'completed',
        message: expect.stringContaining('turn already running'),
      }),
    ]);
    ctx.amp.assistant([{ type: 'text', text: 'stopped' }], 'end_turn');
    await ctx.plugin.agentEnd('done');
    const done = await waitFor(
      ctx.events,
      ctx.adapter,
      'turn.completed',
      (e) => e.turnId === 'turn-1'
    );
    expect(done.outcome).toBe('completed');
    expect(eventsOf(ctx.events, 'content.delta').map((e) => [e.turnId, e.delta])).toEqual([
      ['turn-1', 'stopped'],
    ]);
    expect(eventsOf(ctx.events, 'turn.completed')).toHaveLength(2);
  });

  it('runs a steered message as its own turn when the turn it was steered into had already ended', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    const steered = await ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'stop',
    });
    expect(steered).toEqual({ turnId: 'turn-2' });
    ctx.amp.assistant([{ type: 'text', text: '1 2 3' }], 'end_turn');
    await ctx.plugin.agentEnd('done');
    await waitFor(ctx.events, ctx.adapter, 'turn.completed', (e) => e.turnId === 'turn-1');
    ctx.amp.echoUser('stop');
    const second = await waitFor(
      ctx.events,
      ctx.adapter,
      'turn.started',
      (e) => e.turnId === 'turn-2'
    );
    expect(second.turnId).toBe('turn-2');
    ctx.amp.assistant([{ type: 'text', text: 'ok' }], 'end_turn');
    await ctx.plugin.agentEnd('done');
    const done = await waitFor(
      ctx.events,
      ctx.adapter,
      'turn.completed',
      (e) => e.turnId === 'turn-2'
    );
    expect(done.outcome).toBe('completed');
  });

  it('warns when a turn asks for another mode, which a thread cannot change', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'hi',
      model: { id: 'ultra' },
    });
    expect(eventsOf(ctx.events, 'runtime.warning')[0]?.message).toContain('high');
  });

  it('sends images as image blocks and names other attachments in the text', async () => {
    const ctx = await start({ runtimeMode: 'full-access', systemContext: undefined });
    const image = join(home, 'pic.png');
    await writeFile(image, Buffer.from([1, 2, 3]));
    await ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-1',
      text: 'look',
      attachments: [
        { path: image, mimeType: 'image/png' },
        { path: join(home, 'notes.pdf'), mimeType: 'application/pdf' },
      ],
    });
    const content = (ctx.amp.received[0]!.message as { content: Record<string, unknown>[] })
      .content;
    expect(content[0]).toEqual({
      type: 'text',
      text: `look\n\nAttached file: ${join(home, 'notes.pdf')} (notes.pdf)`,
    });
    expect(content[1]).toEqual({
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/png',
        data: Buffer.from([1, 2, 3]).toString('base64'),
      },
    });
  });

  it('reports a result error and a system error as a failed turn', async () => {
    const ctx = await start({ runtimeMode: 'full-access' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    ctx.amp.send({
      type: 'system',
      subtype: 'error_max_turns',
      error: 'too many turns',
      session_id: 'T-1',
    });
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done).toMatchObject({ outcome: 'error', message: 'too many turns' });
    expect(eventsOf(ctx.events, 'runtime.error')[0]?.message).toBe('too many turns');
  });

  it('follows background subagents past the turn that started them', async () => {
    const ctx = await start({ runtimeMode: 'full-access' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'go' });
    ctx.amp.assistant(
      [
        {
          type: 'tool_use',
          id: 'toolu_bg',
          name: 'Task',
          input: { description: 'research', mode: 'async' },
        },
      ],
      'tool_use'
    );
    await waitFor(ctx.events, ctx.adapter, 'item.started', (e) => e.item.id === 'toolu_bg');
    expect(ctx.adapter.hasBackgroundWork('session-1')).toBe(true);
    ctx.amp.assistant([{ type: 'text', text: 'started it' }], 'end_turn');
    await ctx.plugin.agentEnd('done');
    await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(ctx.adapter.hasBackgroundWork('session-1')).toBe(true);
    ctx.amp.send({
      type: 'system',
      subtype: 'subagent_finished',
      tool_use_id: 'toolu_bg',
      status: 'completed',
      session_id: 'T-1',
    });
    const finished = await waitFor(
      ctx.events,
      ctx.adapter,
      'item.completed',
      (e) => e.item.id === 'toolu_bg'
    );
    expect(finished.item).toMatchObject({ type: 'subagent', status: 'completed' });
    expect(ctx.adapter.hasBackgroundWork('session-1')).toBe(false);
  });
});

describe('AmpAdapter approvals', () => {
  it('asks the room about a command and lets it run only once accepted', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'run it' });
    ctx.amp.assistant(
      [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'echo hi > a.txt' } }],
      'tool_use'
    );
    const deciding = ctx.plugin.toolCall({
      toolUseID: 'toolu_1',
      tool: 'Bash',
      input: { cmd: 'echo hi > a.txt' },
      command: 'echo hi > a.txt',
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    expect(request).toMatchObject({
      turnId: 'turn-1',
      requestType: 'command_execution_approval',
      title: 'Run a Bash command',
      detail: 'echo hi > a.txt',
    });
    expect(request.options.map((o) => o.decision)).toEqual([
      'accept',
      'acceptForSession',
      'decline',
      'cancel',
    ]);
    expect(request.connector).toBeUndefined();
    await ctx.adapter.respondToRequest('session-1', request.requestId, 'accept');
    expect(await deciding).toEqual({ status: 'allow' });
    expect(eventsOf(ctx.events, 'request.resolved')[0]).toMatchObject({
      requestId: request.requestId,
      decision: 'accept',
    });
    ctx.amp.toolResult('toolu_1', '');
    const item = await waitFor(
      ctx.events,
      ctx.adapter,
      'item.completed',
      (e) => e.item.id === 'toolu_1'
    );
    expect(item.item.status).toBe('completed');
  });

  it('refuses a declined tool, and shows it as declined when amp reports the refusal', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'run it' });
    ctx.amp.assistant(
      [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { cmd: 'rm -rf x' } }],
      'tool_use'
    );
    const deciding = ctx.plugin.toolCall({
      toolUseID: 'toolu_1',
      tool: 'Bash',
      input: { cmd: 'rm -rf x' },
      command: 'rm -rf x',
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    await ctx.adapter.respondToRequest('session-1', request.requestId, 'decline');
    const decision = await deciding;
    expect(decision.status).toBe('reject');
    expect(decision.status === 'reject' && decision.message).toMatch(/declined/);
    ctx.amp.toolResult('toolu_1', 'The user declined this tool call in Switch.', true);
    const item = await waitFor(
      ctx.events,
      ctx.adapter,
      'item.completed',
      (e) => e.item.id === 'toolu_1'
    );
    expect(item.item.status).toBe('declined');
  });

  it('tells a waiting plugin to ask again until the room answers', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, decisionWaitMs: 50 },
    });
    adapters.push(adapter);
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const starting = adapter.startSession(startInput());
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    const amp = spawned[0]!;
    const plugin = new FakePlugin(amp);
    await plugin.ready();
    await starting;
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'run' });
    const first = await plugin.toolCallOnce({
      toolUseID: 'toolu_1',
      tool: 'Bash',
      input: { cmd: 'ls' },
      command: 'ls',
    });
    expect(first).toEqual({ status: 'pending' });
    const again = await plugin.toolCallOnce({
      toolUseID: 'toolu_1',
      tool: 'Bash',
      input: { cmd: 'ls' },
      command: 'ls',
    });
    expect(again).toEqual({ status: 'pending' });
    expect(eventsOf(events, 'request.opened')).toHaveLength(1);
    const waiting = plugin.post('/tool-call/wait', { toolUseID: 'toolu_1' });
    await adapter.respondToRequest(
      'session-1',
      eventsOf(events, 'request.opened')[0]!.requestId,
      'accept'
    );
    expect(await waiting).toEqual({ status: 'allow' });
    expect(await plugin.post('/tool-call/wait', { toolUseID: 'toolu_1' })).toMatchObject({
      status: 'reject',
    });
  });

  it('remembers an allow-for-this-session for the same command', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'run' });
    const first = ctx.plugin.toolCall({
      toolUseID: 'toolu_1',
      tool: 'Bash',
      input: { cmd: 'npm test' },
      command: 'npm test',
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    await ctx.adapter.respondToRequest('session-1', request.requestId, 'acceptForSession');
    expect(await first).toEqual({ status: 'allow' });
    expect(
      await ctx.plugin.toolCall({
        toolUseID: 'toolu_2',
        tool: 'Bash',
        input: { cmd: 'npm test' },
        command: 'npm test',
      })
    ).toEqual({ status: 'allow' });
    const other = ctx.plugin.toolCall({
      toolUseID: 'toolu_3',
      tool: 'Bash',
      input: { cmd: 'npm publish' },
      command: 'npm publish',
    });
    await waitFor(ctx.events, ctx.adapter, 'request.opened', (e) => e.detail === 'npm publish');
    expect(eventsOf(ctx.events, 'request.opened')).toHaveLength(2);
    await ctx.adapter.respondToRequest(
      'session-1',
      eventsOf(ctx.events, 'request.opened')[1]!.requestId,
      'decline'
    );
    expect((await other).status).toBe('reject');
  });

  it('allows Switch’s own tools and asks about a connector’s, naming the connector', async () => {
    const ctx = await start({
      mcpServers: {
        switch: { transport: 'http', url: 'http://127.0.0.1:9/mcp' },
        github: { transport: 'http', url: 'http://127.0.0.1:9/github' },
      },
      connectorMcpServers: ['github'],
    });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'go' });
    expect(
      await ctx.plugin.toolCall({
        toolUseID: 't1',
        tool: 'mcp__switch__send_message',
        input: { text: 'hi' },
      })
    ).toEqual({ status: 'allow' });
    expect(
      await ctx.plugin.toolCall({ toolUseID: 't2', tool: 'Read', input: { path: 'a' } })
    ).toEqual({ status: 'allow' });
    expect(eventsOf(ctx.events, 'request.opened')).toHaveLength(0);
    const deciding = ctx.plugin.toolCall({
      toolUseID: 't3',
      tool: 'mcp__github__create_issue',
      input: { title: 'bug' },
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    expect(request).toMatchObject({
      requestType: 'mcp_tool_approval',
      title: 'github wants to run create_issue',
      detail: '{"title":"bug"}',
      connector: 'github',
    });
    await ctx.adapter.respondToRequest('session-1', request.requestId, 'accept');
    expect(await deciding).toEqual({ status: 'allow' });
  });

  it('never asks in full access', async () => {
    const ctx = await start({ runtimeMode: 'full-access' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'go' });
    expect(
      await ctx.plugin.toolCall({
        toolUseID: 't1',
        tool: 'Bash',
        input: { cmd: 'rm -rf x' },
        command: 'rm -rf x',
      })
    ).toEqual({ status: 'allow' });
    expect(eventsOf(ctx.events, 'request.opened')).toHaveLength(0);
  });

  it('lets edits run in auto mode and asks about commands', async () => {
    const ctx = await start({ runtimeMode: 'auto' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'go' });
    expect(
      await ctx.plugin.toolCall({ toolUseID: 't1', tool: 'edit_file', input: { path: 'a.ts' } })
    ).toEqual({ status: 'allow' });
    const deciding = ctx.plugin.toolCall({
      toolUseID: 't2',
      tool: 'Bash',
      input: { cmd: 'make' },
      command: 'make',
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    expect(request.requestType).toBe('command_execution_approval');
    await ctx.adapter.respondToRequest('session-1', request.requestId, 'decline');
    expect((await deciding).status).toBe('reject');
  });

  it('refuses a request from a plugin with the wrong token', async () => {
    const ctx = await start();
    const response = await fetch(`${ctx.amp.env.SWITCH_AMP_PLUGIN_ENDPOINT}/ready`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(401);
  });

  it('cancels open requests when the session stops, refusing the tools', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'go' });
    const deciding = ctx.plugin.toolCall({
      toolUseID: 't1',
      tool: 'Bash',
      input: { cmd: 'ls' },
      command: 'ls',
    });
    const request = await waitFor(ctx.events, ctx.adapter, 'request.opened');
    await ctx.adapter.stopSession('session-1');
    expect(eventsOf(ctx.events, 'request.resolved')[0]).toMatchObject({
      requestId: request.requestId,
      decision: 'cancel',
    });
    expect((await deciding).status).toBe('reject');
    await expect(
      ctx.adapter.respondToRequest('session-1', request.requestId, 'accept')
    ).rejects.toThrow(/unknown or stopped/);
  });
});

describe('AmpAdapter interrupts and lifecycle', () => {
  it('cancels a turn through the plugin and reports it interrupted', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    const control = ctx.plugin.control();
    await tick();
    await ctx.adapter.interruptTurn('session-1');
    expect(await control).toEqual({ kind: 'cancel', threadId: 'T-1' });
    await ctx.plugin.cancelled(true);
    await ctx.plugin.agentEnd('cancelled');
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done).toMatchObject({ turnId: 'turn-1', outcome: 'interrupted' });
    expect(ctx.amp.killed).toBeNull();
    expect(spawned).toHaveLength(1);
    // The same process takes the next turn.
    await completeTurn(ctx, 'turn-2', 'ok');
    const next = await waitFor(
      ctx.events,
      ctx.adapter,
      'turn.completed',
      (e) => e.turnId === 'turn-2'
    );
    expect(next.outcome).toBe('completed');
  });

  it('answers a control poll with nothing when no command arrives in time', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, controlWaitMs: 50 },
    });
    adapters.push(adapter);
    const starting = adapter.startSession(startInput({ runtimeMode: 'full-access' }));
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    const plugin = new FakePlugin(spawned[0]!);
    await plugin.ready();
    await starting;
    expect(await plugin.control()).toEqual({ kind: 'none' });
  });

  it('stops the process when the plugin cannot cancel, and continues the thread for the next turn', async () => {
    const ctx = await start();
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    const control = ctx.plugin.control();
    await tick();
    await ctx.adapter.interruptTurn('session-1');
    expect((await control).kind).toBe('cancel');
    await ctx.plugin.cancelled(false, 'unknown thread');
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done.outcome).toBe('interrupted');
    expect(ctx.amp.killed).toBe('SIGTERM');
    expect(eventsOf(ctx.events, 'session.exited')).toHaveLength(0);
    expect(ctx.adapter.hasSession('session-1')).toBe(true);

    const sending = ctx.adapter.sendTurn({
      sessionId: 'session-1',
      turnId: 'turn-2',
      text: 'next',
    });
    await vi.waitFor(() => expect(spawned.length).toBe(2));
    const second = spawned[1]!;
    expect(second.args.slice(0, 3)).toEqual(['threads', 'continue', 'T-1']);
    await new FakePlugin(second).ready();
    await sending;
    expect((second.received[0]!.message as { content: { text: string }[] }).content[0]!.text).toBe(
      'next'
    );
  });

  it('stops the process when the plugin never applied the cancel in time', async () => {
    const adapter = createAmpAdapter({
      sessionsRoot: join(home, 'sessions'),
      timeouts: { ...TIMEOUTS, cancelMs: 100 },
    });
    adapters.push(adapter);
    const events: ProviderRuntimeEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    const starting = adapter.startSession(startInput());
    await vi.waitFor(() => expect(spawned.length).toBe(1));
    const amp = spawned[0]!;
    await new FakePlugin(amp).ready();
    await starting;
    await adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    await adapter.interruptTurn('session-1');
    const done = await waitFor(events, adapter, 'turn.completed');
    expect(done.outcome).toBe('interrupted');
    expect(amp.killed).toBe('SIGTERM');
  });

  it('interrupts without the plugin by stopping the process', async () => {
    const ctx = await start({ runtimeMode: 'full-access' }, { plugin: false });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'count' });
    await ctx.adapter.interruptTurn('session-1');
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done.outcome).toBe('interrupted');
    expect(ctx.amp.killed).toBe('SIGTERM');
    expect(ctx.adapter.hasSession('session-1')).toBe(true);
  });

  it('does nothing on interrupt when no turn is running', async () => {
    const ctx = await start();
    await ctx.adapter.interruptTurn('session-1');
    expect(ctx.amp.killed).toBeNull();
    expect(eventsOf(ctx.events, 'turn.completed')).toHaveLength(0);
  });

  it('reports an unexpected exit as a failed turn and a gone session, with stderr', async () => {
    const ctx = await start({ runtimeMode: 'full-access' });
    await ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-1', text: 'hi' });
    ctx.amp.stderr.write('out of credits\n');
    await tick();
    ctx.amp.exit(1, null);
    const done = await waitFor(ctx.events, ctx.adapter, 'turn.completed');
    expect(done.outcome).toBe('error');
    expect(done.message).toContain('out of credits');
    const exited = await waitFor(ctx.events, ctx.adapter, 'session.exited');
    expect(exited.reason).toContain('code 1');
    expect(ctx.adapter.hasSession('session-1')).toBe(false);
    await expect(
      ctx.adapter.sendTurn({ sessionId: 'session-1', turnId: 'turn-2', text: 'x' })
    ).rejects.toThrow(/unknown or stopped/);
  });

  it('stops a session by closing amp’s input and removes its configuration', async () => {
    const ctx = await start();
    const configHome = ctx.amp.env.XDG_CONFIG_HOME!;
    await ctx.adapter.stopSession('session-1');
    expect(ctx.amp.killed).toBeNull();
    const exited = await waitFor(ctx.events, ctx.adapter, 'session.exited');
    expect(exited.reason).toBe('stopped by Switch');
    expect(eventsOf(ctx.events, 'runtime.error')).toHaveLength(0);
    expect(eventsOf(ctx.events, 'session.state.changed').at(-1)?.status).toBe('stopped');
    expect(ctx.adapter.hasSession('session-1')).toBe(false);
    await expect(stat(configHome)).rejects.toThrow();
    await ctx.adapter.stopSession('session-1');
  });

  it('lists the Dial modes as the models and has no in-session model switch', async () => {
    const ctx = await start();
    expect((await ctx.adapter.listModels('session-1')).map((m) => m.id)).toEqual([
      'low',
      'medium',
      'high',
      'ultra',
    ]);
    expect(ctx.adapter.capabilities).toEqual({
      modelSwitchInSession: false,
      steering: true,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect('setModel' in ctx.adapter).toBe(false);
    await expect(ctx.adapter.respondToUserInput('session-1', 'q', {})).rejects.toThrow(
      /no open question/
    );
  });

  it('refuses to start a session twice under one id', async () => {
    const ctx = await start();
    await expect(ctx.adapter.startSession(ctx.input)).rejects.toThrow(/already started/);
  });

  it('runs sessions in the mode they ask for', async () => {
    for (const runtimeMode of [
      'approval-required',
      'auto-accept-edits',
      'auto',
      'full-access',
    ] as RuntimeMode[]) {
      spawned.length = 0;
      const ctx = await start({ sessionId: `session-${runtimeMode}`, runtimeMode });
      expect(ctx.session.sessionId).toBe(`session-${runtimeMode}`);
      await ctx.adapter.stopSession(ctx.session.sessionId);
    }
  });
});
