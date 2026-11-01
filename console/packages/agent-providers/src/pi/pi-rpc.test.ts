import type * as ChildProcessModule from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakePi,
  fakePiCommands,
  fakePiConfirm,
  fakePiNotify,
  fakePiState,
  fakePiTextTurn,
} from './fake-pi';
import type { PiRpcEvent } from './pi-rpc';

const processes: FakePi[] = [];
/** When set, `spawn` starts a real process instead of a `FakePi`. */
let realSpawn = false;

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (...args: Parameters<typeof actual.spawn>) => {
      if (realSpawn) return actual.spawn(...args);
      const fake = new FakePi();
      processes.push(fake);
      return fake;
    },
  };
});

// On Windows `stopProvider` ends the process tree; here that ends the fake.
const killProcessTree = vi.hoisted(() => vi.fn());
vi.mock('../host/process-fence', () => ({ killProcessTree }));

const { PiRpcClient, PiRpcError, OUTPUT_DRAIN_MS } = await import('./pi-rpc');

function connect(options: { maxLineBytes?: number; command?: string } = {}) {
  const events: PiRpcEvent[] = [];
  const exits: string[] = [];
  const warn = vi.fn();
  const client = new PiRpcClient({
    command: 'pi',
    args: ['--mode', 'rpc'],
    cwd: '/tmp',
    env: {},
    logger: { debug: () => {}, warn, error: () => {} },
    onEvent: (event) => events.push(event),
    onExit: (reason) => exits.push(reason),
    ...options,
  });
  if (realSpawn) return { client, pi: undefined as unknown as FakePi, events, exits, warn };
  const pi = processes.at(-1);
  if (!pi) throw new Error('fake pi was not spawned');
  return { client, pi, events, exits, warn };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
/** Makes `process.platform` read as `value` until the end of the test. */
function onPlatform(value: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...platform, value });
}

beforeEach(() => {
  processes.length = 0;
  realSpawn = false;
  killProcessTree.mockReset();
  killProcessTree.mockImplementation(async (pid: number) => {
    for (const pi of processes) if (pi.pid === pid) pi.exit(null, 'SIGKILL');
  });
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', platform);
  for (const pi of processes) pi.removeAllListeners();
});

describe('PiRpcClient framing', () => {
  it('joins a line split between chunks, including inside a multi-byte character', async () => {
    const { pi, events } = connect();
    const bytes = Buffer.from(`${JSON.stringify({ type: 'notice', text: 'zażółć' })}\r\n`, 'utf8');
    const cut = bytes.indexOf(Buffer.from('ż', 'utf8')) + 1;
    pi.emitRaw(bytes.subarray(0, 5));
    pi.emitRaw(bytes.subarray(5, cut));
    await tick();
    expect(events).toEqual([]);
    pi.emitRaw(bytes.subarray(cut));
    await tick();
    expect(events).toEqual([{ type: 'notice', text: 'zażółć' }]);
  });

  it('splits on LF only, so U+2028 inside a string stays in its record', async () => {
    const { pi, events } = connect();
    pi.emitRaw(`${JSON.stringify({ type: 'a', text: 'one two three' })}\n{"type":"b"}\n`);
    await tick();
    expect(events).toEqual([{ type: 'a', text: 'one two three' }, { type: 'b' }]);
  });

  it('ignores a line that is not JSON, logs it, and keeps reading', async () => {
    const { client, pi, events, exits, warn } = connect();
    pi.emitRaw('Debugger attached.\n[1, 2]\n{"no":"type"}\n\n{"type":"agent_start"}\n');
    await tick();
    expect(events).toEqual([{ type: 'agent_start' }]);
    expect(warn).toHaveBeenCalledWith('provider process emitted a line that is not JSON', {
      line: 'Debugger attached.',
    });
    expect(warn).toHaveBeenCalledTimes(3);
    expect(exits).toEqual([]);
    expect(client.isAlive).toBe(true);
    await expect(client.request('get_state')).resolves.toEqual(fakePiState());
  });

  it('drops the CR of a CRLF line before logging it, in a terminated and in a last unterminated line', async () => {
    const { pi, warn } = connect();
    pi.emitRaw('not json\r\nstill not json\r');
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith('provider process emitted a line that is not JSON', {
      line: 'not json',
    });
    pi.endOutput();
    await tick();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('provider process emitted a line that is not JSON', {
      line: 'still not json',
    });
  });

  it('interrupts the process when a line grows past the limit, even without a newline', async () => {
    const { client, pi, events, exits } = connect({ maxLineBytes: 64 });
    pi.handlers.delete('get_state');
    const pending = client.request('get_state');
    pi.emitRaw('x'.repeat(40));
    await tick();
    expect(exits).toEqual([]);
    pi.emitRaw('x'.repeat(40));
    await expect(pending).rejects.toThrow('exceeds 64 bytes');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toContain('exceeds 64 bytes');
    expect(pi.signals).toEqual(['SIGKILL']);
    pi.emitRaw('\n{"type":"agent_start"}\n');
    await tick();
    expect(events).toEqual([]);
    expect(client.isAlive).toBe(false);
  });

  it('accepts a line exactly at the limit', async () => {
    const line = JSON.stringify({ type: 'pad', text: 'y'.repeat(20) });
    const { pi, events, exits } = connect({ maxLineBytes: Buffer.byteLength(line) });
    pi.emitRaw(`${line}\n`);
    await tick();
    expect(exits).toEqual([]);
    expect(events).toHaveLength(1);
  });
});

describe('PiRpcClient commands', () => {
  it('writes the command with its own id and type and resolves the response data', async () => {
    const { client, pi } = connect();
    await expect(client.request('get_commands')).resolves.toEqual(fakePiCommands());
    await expect(client.request('prompt', { message: 'hi' })).resolves.toEqual({
      disposition: 'started',
    });
    expect(pi.received).toEqual([
      { id: 'sw1', type: 'get_commands' },
      { id: 'sw2', type: 'prompt', message: 'hi' },
    ]);
  });

  it('does not let params override the id or type', async () => {
    const { client, pi } = connect();
    await client.request('get_state', { id: 'forged', type: 'abort' });
    expect(pi.received).toEqual([{ id: 'sw1', type: 'get_state' }]);
  });

  it('matches responses by id when they arrive out of order among events', async () => {
    const { client, pi, events } = connect();
    pi.handlers.clear();
    const first = client.request('get_state');
    const second = client.request('get_commands');
    await pi.waitFor('get_commands');
    const confirm = fakePiConfirm('707fcbaf-1854-4129-b3e4-8da6cfa9d978', 'gate:bieg=1:bash', '{}');
    pi.emitRecord({ type: 'agent_start' });
    pi.respond('sw2', 'get_commands', { data: fakePiCommands() });
    pi.emitRecord(confirm);
    pi.respond('sw1', 'get_state', { data: fakePiState({ messageCount: 5 }) });
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await expect(second).resolves.toEqual(fakePiCommands());
    await expect(first).resolves.toEqual(fakePiState({ messageCount: 5 }));
    // An extension UI request carries an id of Pi's own; it is an event, not a response.
    expect(events).toEqual([
      { type: 'agent_start' },
      confirm,
      { type: 'agent_settled', aborted: false },
    ]);
  });

  it('rejects with the error Pi gives when a command fails', async () => {
    const { client, pi } = connect();
    pi.handlers.set('prompt', () => ({ error: 'No API key found for fakenoauth.' }));
    const failed = client.request('prompt', { message: 'hi' });
    await expect(failed).rejects.toBeInstanceOf(PiRpcError);
    await expect(failed).rejects.toThrow('No API key found for fakenoauth.');
    expect(client.isAlive).toBe(true);
  });

  it('logs a response that matches no pending command and does not pass it on as an event', async () => {
    const { client, pi, events, warn } = connect();
    pi.respond(undefined, 'parse', { error: 'Failed to parse command: Unexpected token' });
    pi.respond('sw99', 'get_state', { data: {} });
    await tick();
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(client.isAlive).toBe(true);
  });

  it('writes records Pi does not answer, such as extension_ui_response', async () => {
    const { client, pi } = connect();
    client.send({ type: 'extension_ui_response', id: 'ui-1', confirmed: false });
    await expect(pi.waitFor('extension_ui_response')).resolves.toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      confirmed: false,
    });
  });

  it('times out an unanswered command without resending it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi } = connect();
    pi.handlers.clear();
    const pending = client.request('abort', {}, { timeoutMs: 1000 });
    const rejected = expect(pending).rejects.toThrow('outcome is unknown and it was not resent');
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(pi.received.filter((command) => command.type === 'abort')).toHaveLength(1);
  });

  it('clears the timeout of a command as soon as it is answered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi } = connect();
    pi.handlers.clear();
    const answered = client.request('get_state', {}, { timeoutMs: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    pi.respond('sw1', 'get_state', { data: fakePiState() });
    await expect(answered).resolves.toEqual(fakePiState());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('PiRpcClient process lifetime', () => {
  it('rejects every pending command when the process exits, and reports the exit once', async () => {
    const { client, pi, exits } = connect();
    pi.handlers.clear();
    const pending = [client.request('get_state'), client.request('prompt', { message: 'x' })];
    pi.exit(1, null);
    pi.exit(1, null);
    await expect(pending[0]).rejects.toThrow(
      'provider process exited (code 1, signal null) while awaiting get_state'
    );
    await expect(pending[1]).rejects.toThrow('while awaiting prompt');
    await tick();
    expect(exits).toEqual(['provider process exited (code 1, signal null)']);
    expect(client.isAlive).toBe(false);
    await expect(client.request('get_state')).rejects.toThrow('process is gone');
    expect(() => client.send({ type: 'extension_ui_response', id: 'u' })).toThrow(
      'process is gone'
    );
  });

  it('reads what Pi wrote before it exited on its own, then reports the exit', async () => {
    const { client, pi, events, exits } = connect();
    pi.handlers.clear();
    const pending = client.request('get_state');
    pi.exit(0, null, { endOutput: false });
    await expect(pending).rejects.toThrow('provider process exited (code 0, signal null)');
    expect(client.isAlive).toBe(false);
    // Node may report the exit before the last chunks of stdout are read.
    pi.emitRecord({ type: 'message_end', message: { role: 'assistant' } });
    pi.emitRaw('{"type":"agent_settled","aborted":false}');
    await tick();
    expect(events).toEqual([{ type: 'message_end', message: { role: 'assistant' } }]);
    expect(exits).toEqual([]);
    pi.endOutput();
    await tick();
    expect(events).toEqual([
      { type: 'message_end', message: { role: 'assistant' } },
      { type: 'agent_settled', aborted: false },
    ]);
    expect(exits).toEqual(['provider process exited (code 0, signal null)']);
  });

  it('delivers a last event written just before the process exits', async () => {
    const { pi, events, exits } = connect();
    pi.emitRaw('{"type":"agent_settled","aborted":false}');
    pi.exit(0, null);
    await tick();
    expect(events).toEqual([{ type: 'agent_settled', aborted: false }]);
    expect(exits).toEqual(['provider process exited (code 0, signal null)']);
  });

  it('reports the exit after the drain time when the output of an exited process never ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pi, events, exits } = connect();
    pi.exit(0, null, { endOutput: false });
    await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS - 1);
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(exits).toEqual(['provider process exited (code 0, signal null)']);
    pi.emitRecord({ type: 'agent_start' });
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets go of the output streams once it stops waiting for them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { pi, events, exits } = connect();
    const listeners = () => [
      pi.stdout.listenerCount('data'),
      pi.stdout.listenerCount('end'),
      pi.stdout.listenerCount('close'),
      pi.stderr.listenerCount('data'),
    ];
    expect(listeners()).toEqual([1, 1, 1, 1]);
    pi.emitRaw('{"type":"agent_settled"');
    pi.exit(0, null, { endOutput: false });
    await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS);
    expect(exits).toEqual(['provider process exited (code 0, signal null)']);
    expect(pi.stdout.destroyed).toBe(true);
    expect(pi.stderr.destroyed).toBe(true);
    expect(listeners()).toEqual([0, 0, 0, 0]);
    expect(events).toEqual([]);
  });

  it('lets go of the output streams when disposed while the output of an exited process drains', async () => {
    const { client, pi, exits } = connect();
    pi.exit(0, null, { endOutput: false });
    await client.dispose();
    expect(exits).toEqual(['provider process exited (code 0, signal null)']);
    expect(pi.stdout.destroyed).toBe(true);
    expect(pi.stderr.destroyed).toBe(true);
    expect(pi.stdout.listenerCount('data')).toBe(0);
  });

  it.each([
    ['stdout', 'output'],
    ['stderr', 'error output'],
  ] as const)('ends the client when %s fails, without crashing', async (stream, label) => {
    const { client, pi, exits, warn } = connect();
    pi.handlers.clear();
    const pending = client.request('get_state');
    pi[stream].emit('error', new Error('read EIO'));
    await expect(pending).rejects.toThrow(
      `provider ${label} stream failed: read EIO while awaiting get_state`
    );
    expect(warn).toHaveBeenCalledWith(`provider ${label} stream failed`, { error: 'read EIO' });
    expect(exits).toEqual([`provider ${label} stream failed: read EIO`]);
    expect(client.isAlive).toBe(false);
    pi[stream].emit('error', new Error('again'));
    expect(exits).toHaveLength(1);
  });

  it('rejects pending commands and reports once when the process fails to start, without crashing', async () => {
    const { client, pi, exits } = connect();
    pi.handlers.clear();
    const pending = client.request('get_state');
    pi.fail(new Error('spawn pi ENOENT'));
    await expect(pending).rejects.toThrow('spawn failed: spawn pi ENOENT while awaiting get_state');
    pi.fail(new Error('again'));
    expect(exits).toEqual(['spawn failed: spawn pi ENOENT']);
    expect(client.isAlive).toBe(false);
    await expect(client.request('get_state')).rejects.toThrow('process is gone');
  });

  it('survives a real spawn of a binary that does not exist', async () => {
    realSpawn = true;
    const { client, exits } = connect({ command: '/nonexistent/switch-777-pi-xyz' });
    const pending = client.request('get_state');
    await expect(pending).rejects.toThrow(
      'spawn failed: spawn /nonexistent/switch-777-pi-xyz ENOENT while awaiting get_state'
    );
    expect(exits).toEqual(['spawn failed: spawn /nonexistent/switch-777-pi-xyz ENOENT']);
    expect(client.isAlive).toBe(false);
    await tick();
    await client.dispose();
  });

  it('finishes a dispose begun before the start fails, without waiting for an exit that never comes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi, exits, warn } = connect();
    pi.stdin.removeAllListeners('finish');
    // As Node 24 does for a binary that cannot be started: kill() fails, then
    // `error` without a pid, and no `exit`.
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      return false;
    };
    const errorListeners = pi.listenerCount('error');
    let outcome = 'pending';
    const disposed = client.dispose().then(
      () => (outcome = 'resolved'),
      (error: Error) => (outcome = error.message)
    );
    expect(pi.signals).toEqual(['SIGTERM']);
    pi.fail(new Error('spawn pi ENOENT'));
    await tick();
    expect(outcome).toBe('resolved');
    await disposed;
    expect(exits).toEqual(['spawn failed: spawn pi ENOENT']);
    expect(warn).not.toHaveBeenCalledWith(
      'provider process did not exit after termination',
      expect.anything()
    );
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.listenerCount('exit')).toBe(1);
    expect(pi.listenerCount('error')).toBe(errorListeners);
    await client.dispose();
    expect(pi.signals).toEqual(['SIGTERM']);
  });

  it('stops writing when the input fails, still reads what Pi wrote, then reports, without crashing', async () => {
    const { client, pi, events, exits, warn } = connect();
    pi.handlers.clear();
    const pending = client.request('get_state');
    pi.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(pending).rejects.toThrow(
      'provider input stream failed: write EPIPE while awaiting get_state'
    );
    expect(warn).toHaveBeenCalledWith('provider input could not be written', {
      error: 'write EPIPE',
    });
    expect(client.isAlive).toBe(false);
    pi.emitRecord({ type: 'agent_settled', aborted: false });
    await tick();
    expect(events).toEqual([{ type: 'agent_settled', aborted: false }]);
    expect(exits).toEqual([]);
    pi.exit(null, 'SIGKILL');
    await tick();
    expect(exits).toEqual(['provider input stream failed: write EPIPE']);
  });

  it('stops the process with SIGTERM alone, rejects pending commands at once, and drops later output', async () => {
    const { client, pi, events, exits } = connect();
    pi.handlers.clear();
    const pending = client.request('get_state');
    const disposed = client.dispose();
    await expect(pending).rejects.toThrow('provider process was stopped while awaiting get_state');
    await disposed;
    // One request to shut down: a second one makes Pi exit without cleaning up.
    expect(pi.signals).toEqual(['SIGTERM']);
    expect(pi.stdin.writableEnded).toBe(false);
    expect(exits).toEqual(['provider process exited (code null, signal SIGTERM)']);
    pi.emitRecord({ type: 'agent_settled', aborted: true });
    await tick();
    expect(events).toEqual([]);
    await client.dispose();
  });

  it('kills a process that ignores SIGTERM after two seconds', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi } = connect();
    pi.stdin.removeAllListeners('finish');
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      if (signal === 'SIGKILL') pi.exit(null, 'SIGKILL');
      return true;
    };
    const disposed = client.dispose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(pi.signals).toEqual(['SIGTERM']);
    await vi.advanceTimersByTimeAsync(1);
    await disposed;
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(pi.stdin.writableEnded).toBe(false);
  });

  it('sends one SIGTERM when dispose is called again before the process is gone', async () => {
    const { client, pi, exits } = connect();
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      return true;
    };
    const first = client.dispose();
    const second = client.dispose();
    expect(second).toBe(first);
    await tick();
    expect(pi.signals).toEqual(['SIGTERM']);
    pi.exit(null, 'SIGTERM');
    await Promise.all([first, second]);
    expect(pi.signals).toEqual(['SIGTERM']);
    expect(exits).toEqual(['provider process exited (code null, signal SIGTERM)']);
  });

  it('gives up five seconds after SIGTERM on a process that survives SIGKILL too', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi } = connect();
    pi.stdin.removeAllListeners('finish');
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      return true;
    };
    let outcome = 'pending';
    const disposed = client.dispose().then(
      () => (outcome = 'resolved'),
      (error: Error) => (outcome = error.message)
    );
    await vi.advanceTimersByTimeAsync(4999);
    expect(outcome).toBe('pending');
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(1);
    // Checked before awaiting, so a dispose that hangs fails here, not on the test timeout.
    expect(outcome).toBe('Provider process did not exit after termination.');
    await disposed;
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.listenerCount('exit')).toBe(1);
  });

  it('on Windows stops the process by ending its input alone', async () => {
    const { client, pi } = connect();
    onPlatform('win32');
    await client.dispose();
    expect(pi.stdin.writableEnded).toBe(true);
    expect(pi.signals).toEqual([]);
    expect(killProcessTree).not.toHaveBeenCalled();
  });

  it('on Windows ends the process tree when the process stays after its input ends', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi } = connect();
    pi.stdin.removeAllListeners('finish');
    onPlatform('win32');
    const disposed = client.dispose();
    await vi.advanceTimersByTimeAsync(1999);
    expect(killProcessTree).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await disposed;
    expect(pi.stdin.writableEnded).toBe(true);
    expect(killProcessTree).toHaveBeenCalledTimes(1);
    expect(killProcessTree).toHaveBeenCalledWith(pi.pid);
    expect(pi.signals).toEqual([]);
  });
});

type Pi = InstanceType<typeof FakePi>;
type Client = InstanceType<typeof PiRpcClient>;

const outputListeners = (pi: Pi) => [
  pi.stdout.listenerCount('data'),
  pi.stdout.listenerCount('end'),
  pi.stdout.listenerCount('close'),
  pi.stderr.listenerCount('data'),
];

/** A process that ignores every signal, as one stuck in the kernel does. */
function ignoreSignals(pi: Pi) {
  pi.stdin.removeAllListeners('finish');
  pi.kill = (signal?: NodeJS.Signals) => {
    pi.signals.push(signal ?? 'SIGTERM');
    return true;
  };
}

const EXITED = 'provider process exited (code 0, signal null)';
const GAVE_UP = 'Provider process did not exit after termination.';

/** Every way the client can be finished with the process. */
const ENDINGS: {
  path: string;
  reason: string;
  maxLineBytes?: number;
  end: (client: Client, pi: Pi) => Promise<void>;
}[] = [
  {
    path: 'the process exits after its output ended',
    reason: EXITED,
    end: async (_client, pi) => {
      pi.endOutput();
      await tick();
      pi.exit(0, null, { endOutput: false });
    },
  },
  {
    path: 'the process exits and its output ends after',
    reason: EXITED,
    end: async (_client, pi) => {
      pi.exit(0, null, { endOutput: false });
      await tick();
      pi.endOutput();
      await tick();
    },
  },
  {
    path: 'the output of an exited process outlasts the drain',
    reason: EXITED,
    end: async (_client, pi) => {
      pi.exit(0, null, { endOutput: false });
      await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS);
    },
  },
  {
    path: 'dispose while the output of an exited process drains',
    reason: EXITED,
    end: async (client, pi) => {
      pi.exit(0, null, { endOutput: false });
      await client.dispose();
    },
  },
  {
    path: 'dispose, and the process exits on SIGTERM',
    reason: 'provider process exited (code null, signal SIGTERM)',
    end: (client) => client.dispose(),
  },
  {
    path: 'dispose on Windows, and the process exits when its input ends',
    reason: EXITED,
    end: async (client, pi) => {
      onPlatform('win32');
      pi.stdin.removeAllListeners('finish');
      pi.stdin.on('finish', () => pi.exit(0, null, { endOutput: false }));
      await client.dispose();
    },
  },
  {
    path: 'dispose, and the process exits on SIGKILL',
    reason: 'provider process exited (code null, signal SIGKILL)',
    end: async (client, pi) => {
      pi.kill = (signal?: NodeJS.Signals) => {
        pi.signals.push(signal ?? 'SIGTERM');
        if (signal === 'SIGKILL') pi.exit(null, 'SIGKILL', { endOutput: false });
        return true;
      };
      const disposed = client.dispose();
      await vi.advanceTimersByTimeAsync(2000);
      await disposed;
    },
  },
  {
    path: 'dispose, and the process survives SIGKILL',
    reason: GAVE_UP,
    end: async (client, pi) => {
      ignoreSignals(pi);
      const disposed = client.dispose().then(
        () => 'resolved',
        (error: Error) => error.message
      );
      await vi.advanceTimersByTimeAsync(5000);
      expect(await disposed).toBe(GAVE_UP);
    },
  },
  {
    path: 'the process fails to start',
    reason: 'spawn failed: spawn pi ENOENT',
    end: async (_client, pi) => pi.fail(new Error('spawn pi ENOENT')),
  },
  {
    path: 'stdout fails',
    reason: 'provider output stream failed: read EIO',
    end: async (_client, pi) => {
      pi.stdout.emit('error', new Error('read EIO'));
    },
  },
  {
    path: 'stderr fails',
    reason: 'provider error output stream failed: read EIO',
    end: async (_client, pi) => {
      pi.stderr.emit('error', new Error('read EIO'));
    },
  },
  {
    path: 'stdin fails, and the output stays open',
    reason: 'provider input stream failed: write EPIPE',
    end: async (_client, pi) => {
      pi.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
      await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS);
    },
  },
  {
    path: 'a line grows past the limit',
    reason: 'Provider protocol line exceeds 64 bytes. Execution was interrupted.',
    maxLineBytes: 64,
    end: async (_client, pi) => {
      pi.emitRaw('x'.repeat(80));
      await tick();
    },
  },
];

describe('PiRpcClient end of every path', () => {
  it.each(ENDINGS)(
    'when $path: rejects what waits, stops its timers, lets go of the streams and reports once',
    async ({ reason, maxLineBytes, end }) => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { client, pi, events, exits } = connect({ maxLineBytes });
      pi.handlers.clear();
      const pending = client.request('get_state').then(
        () => 'resolved',
        (error: Error) => error.message
      );
      pi.emitRaw('{"type":"unfinished"');
      await tick();
      expect(outputListeners(pi)).toEqual([1, 1, 1, 1]);
      await end(client, pi);
      expect(await pending).toMatch(/ while awaiting get_state$/);
      expect(exits).toEqual([reason]);
      expect(client.isAlive).toBe(false);
      expect(pi.stdout.destroyed).toBe(true);
      expect(pi.stderr.destroyed).toBe(true);
      expect(outputListeners(pi)).toEqual([0, 0, 0, 0]);
      expect(vi.getTimerCount()).toBe(0);
      expect(pi.listenerCount('exit')).toBe(1);
      // Whatever happens afterwards is not reported again.
      pi.exit(1, null, { endOutput: false });
      pi.stdout.emit('error', new Error('late'));
      pi.fail(new Error('late'));
      await vi.advanceTimersByTimeAsync(OUTPUT_DRAIN_MS);
      expect(exits).toEqual([reason]);
      expect(events).toEqual([]);
    }
  );
});

describe('PiRpcClient dispose of a process that will not go', () => {
  it('tries again on the next dispose, with SIGKILL at once, and keeps a dispose that succeeded', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi, exits } = connect();
    ignoreSignals(pi);
    const first = client.dispose();
    const firstOutcome = first.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(await firstOutcome).toBe(GAVE_UP);
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL']);

    const second = client.dispose();
    expect(second).not.toBe(first);
    const secondOutcome = second.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await tick();
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await secondOutcome).toBe(GAVE_UP);

    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      pi.exit(null, signal ?? 'SIGTERM', { endOutput: false });
      return true;
    };
    const third = client.dispose();
    expect(third).not.toBe(second);
    await third;
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL', 'SIGKILL']);
    expect(client.dispose()).toBe(third);
    await tick();
    expect(pi.signals).toHaveLength(4);
    expect(exits).toEqual([GAVE_UP]);
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.listenerCount('exit')).toBe(1);
  });

  it('does not take a signal that could not be sent for the end of the process', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { client, pi, exits, warn } = connect();
    pi.stdin.removeAllListeners('finish');
    // As Node does when kill() fails on a running child: `error`, pid kept, no `exit`.
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      pi.failSignal(Object.assign(new Error('kill EPERM'), { code: 'EPERM' }));
      return false;
    };
    const first = client.dispose().then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await tick();
    expect(pi.signals).toEqual(['SIGTERM']);
    expect(warn).toHaveBeenCalledWith('provider process could not be signalled', {
      pid: pi.pid,
      error: 'kill EPERM',
    });
    expect(exits).toEqual([]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await first).toBe(GAVE_UP);
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL']);

    let settled = false;
    const second = client.dispose().then(
      () => {
        settled = true;
        return 'resolved';
      },
      (error: Error) => {
        settled = true;
        return error.message;
      }
    );
    await tick();
    expect(pi.signals).toEqual(['SIGTERM', 'SIGKILL', 'SIGKILL']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    pi.exit(null, 'SIGKILL', { endOutput: false });
    expect(await second).toBe('resolved');
    expect(exits).toEqual([GAVE_UP]);
    expect(vi.getTimerCount()).toBe(0);
    expect(pi.listenerCount('exit')).toBe(1);
  });

  it('never leaves the rejection of dispose unhandled, whether it is waited for late or not at all', async () => {
    const unhandled: unknown[] = [];
    const handledLate: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    const onHandledLate = (promise: unknown) => handledLate.push(promise);
    process.on('unhandledRejection', onUnhandled);
    process.on('rejectionHandled', onHandledLate);
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { client, pi, warn } = connect();
      ignoreSignals(pi);
      const late = client.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      await tick();
      await tick();
      await expect(late).rejects.toThrow(GAVE_UP);
      void client.dispose();
      await vi.advanceTimersByTimeAsync(5000);
      await tick();
      await tick();
      expect(unhandled).toEqual([]);
      expect(handledLate).toEqual([]);
      expect(warn).toHaveBeenCalledWith('provider process did not exit after termination', {
        pid: pi.pid,
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
      process.off('rejectionHandled', onHandledLate);
    }
  });
});

describe('FakePi', () => {
  it('answers in the shapes Pi 1.4.0 writes', async () => {
    const pi = new FakePi();
    const lines: unknown[] = [];
    pi.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString('utf8').split('\n')) if (line) lines.push(JSON.parse(line));
    });
    pi.stdin.write('{"id":"c1","type":"get_state"}\n{"id":"c2","type":"prompt","message":"m"}\n');
    pi.stdin.write('{"id":"c3","type":"get_commands"}\n');
    await tick();
    expect(lines).toEqual([
      { id: 'c1', type: 'response', command: 'get_state', success: true, data: fakePiState() },
      {
        id: 'c2',
        type: 'response',
        command: 'prompt',
        success: true,
        data: { disposition: 'started' },
      },
      {
        id: 'c3',
        type: 'response',
        command: 'get_commands',
        success: true,
        data: fakePiCommands(),
      },
    ]);
    expect(Object.keys(fakePiState())).toEqual([
      'model',
      'thinkingLevel',
      'isStreaming',
      'isCompacting',
      'steeringMode',
      'followUpMode',
      'sessionFile',
      'sessionId',
      'autoCompactionEnabled',
      'messageCount',
      'pendingMessageCount',
    ]);
  });

  it('scripts a text turn with the event order of a recorded Pi session', () => {
    // evidence/spike/r2-6-on/rpc-s4-resume.jsonl:9-20
    const turn: Record<string, unknown>[] = fakePiTextTurn(
      'Reply with exactly one word: RESUMED',
      'ok'
    );
    expect(
      turn.map((event) =>
        event.type === 'message_update'
          ? `message_update:${(event.assistantMessageEvent as { type: string }).type}`
          : event.type
      )
    ).toEqual([
      'agent_start',
      'turn_start',
      'message_start',
      'message_end',
      'message_start',
      'message_update:text_start',
      'message_update:text_delta',
      'message_update:text_end',
      'message_end',
      'turn_end',
      'agent_end',
      'agent_settled',
    ]);
    expect(turn.at(-1)).toEqual({ type: 'agent_settled', aborted: false });
    expect(fakePiConfirm('u1', 'gate:bieg=1:bash', '{"command":"ls"}')).toEqual({
      type: 'extension_ui_request',
      id: 'u1',
      method: 'confirm',
      title: 'gate:bieg=1:bash',
      message: '{"command":"ls"}',
    });
    expect(fakePiNotify('u2', 'gate-loaded')).toEqual({
      type: 'extension_ui_request',
      id: 'u2',
      method: 'notify',
      message: 'gate-loaded',
      notifyType: 'info',
    });
  });

  it('exits when its input ends, as Pi does', () => {
    const pi = new FakePi();
    const exit = vi.fn();
    pi.on('exit', exit);
    pi.stdin.end();
    return new Promise<void>((resolve) =>
      setImmediate(() => {
        expect(exit).toHaveBeenCalledWith(0, null);
        resolve();
      })
    );
  });
});
