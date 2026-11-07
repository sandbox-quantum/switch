import type * as ChildProcessModule from 'node:child_process';
import type * as FsModule from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type * as FsPromisesModule from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderConversationUnavailableError, ProviderSessionError } from '../adapter';
import type { ProviderSessionStartInput } from '../adapter';
import type { ProviderRuntimeEvent } from '../events';
import type { PiBridgeConfig } from './bridge';
import { FAKE_PI_MODEL, FakePi, fakePiState, fakePiTextTurn, type FakePiCommand } from './fake-pi';
import { piArgs } from './pi-args';
import {
  piBashArgsFingerprint,
  piBashProcessView,
  piBashPsArgsDigest,
  readPiProcStat,
  readPiPsCommand,
} from './pi-bash';
import type * as PiBashModule from './pi-bash';
import type * as PiConversationModule from './pi-conversation';

/**
 * The Pi adapter against `FakePi` (stage 1): every Pi the adapter starts is a `FakePi` that plays
 * the bridge (handshake, run announcements, `confirm`) as Pi 1.4.0 writes it. Everything before
 * the spawn is real: `preparePiLaunch` with a fake `pi` that prints its version, a profile and a
 * state directory under a temporary HOME. Process groups are real processes (`sh`, `sleep`) when a
 * test is about them, registered in the launch's registry as the bridge registers them.
 */

interface Spawned {
  command: string;
  args: string[];
  options: ChildProcessModule.SpawnOptions;
  pi: FakePi;
  config: PiBridgeConfig | null;
}

const spawned: Spawned[] = [];
/** Called for every new FakePi before the client talks to it. */
let configure: (pi: FakePi, spawn: Spawned) => void = () => {};

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: ChildProcessModule.SpawnOptions) => {
      const pi = new FakePi();
      const configFile = (options.env ?? {}).SWITCH_PI_BRIDGE;
      const config =
        configFile && existsSync(configFile)
          ? (JSON.parse(readFileSync(configFile, 'utf8')) as PiBridgeConfig)
          : null;
      const entry: Spawned = { command, args: [...args], options, pi, config };
      spawned.push(entry);
      standardPi(pi, entry);
      configure(pi, entry);
      return pi;
    },
  };
});
const killProcessTree = vi.hoisted(() => vi.fn());
vi.mock('../host/process-fence', () => ({ killProcessTree }));

/**
 * Round 3 (R3-A, R3-D): what procfs answers for a file (`read`: an error code, or null for the
 * real answer) and a pause before a file is written (`write`). Both pass everything else through.
 */
const fsFaults = vi.hoisted(() => ({
  read: null as null | ((file: string) => string | null),
  write: null as null | ((file: string) => Promise<void>),
  /** Round 5 (R5-A): a pause before a file is read (`node:fs/promises` `readFile`). */
  readAsync: null as null | ((file: string) => Promise<void>),
  /** Round 5 (R5-B, R5-C): instead of a removal (`node:fs/promises` `rm`), given the real one. */
  rm: null as null | ((file: string, real: () => Promise<void>) => Promise<void>),
}));
/**
 * Round 6 (D-16 A′): every I/O call of the adapter and of its conversation store passes `io.on`
 * while it is set: `node:fs/promises` and `node:fs` of the adapter (and of `./pi-bash.ts`, which
 * it calls), and the store's own file system (`fs` injected into every `piConversationStore`, see
 * the mock of `./pi-conversation` below: the store takes `node:fs` from `process.getBuiltinModule`,
 * which no `vi.mock` reaches). A call is placed by the source-mapped stack: `site` is the innermost
 * frame of `pi-adapter.ts` or `pi-conversation.ts` (`file:line`; a call made inside `pi-bash.ts`
 * is an alias of the frame that called it, `via`), `chain` the frames of those two files above it
 * (the same line reached from different callers is a different case). A call with no frame of
 * them (the launch of stage 4, `pi-launch.ts`; the test itself) is `outside`: it is never failed,
 * only counted. The answer says what the call does: nothing (`null`), fail before its effect,
 * after it, or after part of it (`partial`: half the bytes written, one entry of a directory
 * removed); `existsSync` cannot fail, so failing it answers `false`.
 */
const io = vi.hoisted(() => {
  type Mode = 'before' | 'after' | 'partial';
  interface Call {
    op: string;
    file: string;
    site: string;
    via: string | null;
    chain: string;
  }
  const FRAME = /^\s*at (?:async )?(?:(.+?) \()?(.+?):(\d+):\d+\)?$/;
  const OWN = /\/pi\/(pi-adapter|pi-conversation)\.ts$/;
  const ALIAS = /\/pi\/(pi-bash)\.ts$/;
  const SOURCE = /\/src\/[\w/.-]+\.ts$/;
  interface Frame {
    file: string;
    line: number;
    fn: string;
    /** What the frame calls at that line: the frame inside it (`fs.<op>` for the call itself). */
    callee: string;
  }
  const state = {
    on: null as null | ((call: Call) => Mode | null),
    outside: 0,
    /**
     * Places a frame of `pi-conversation.ts` on its source line (in this file the store is the
     * original module behind a mocked id and its frames come without their source map; see
     * `placeStoreFrame` below). Until it is set, the line as it comes.
     */
    place: null as null | ((frame: Frame) => number),
  };
  /** Set while a stack is read: the source maps it needs are read through these mocks too. */
  let reading = false;
  function where(op: string): { site: string; via: string | null; chain: string } | null {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 60;
    reading = true;
    let stack: string;
    try {
      stack = String(new Error('where').stack);
    } finally {
      reading = false;
      Error.stackTraceLimit = limit;
    }
    let via: string | null = null;
    let callee = `fs.${op}`;
    const own: string[] = [];
    for (const text of stack.split('\n').slice(1)) {
      const found = FRAME.exec(text);
      if (!found) continue;
      const fn = (found[1] ?? '').replace(/^(Object|PiAdapter|Module)\./, '');
      const file = found[2] as string;
      const line = Number(found[3]);
      if (file.endsWith('.test.ts')) continue;
      const mine = OWN.exec(file);
      if (mine) {
        const placed =
          mine[1] === 'pi-conversation' && state.place
            ? state.place({ file: 'pi-conversation.ts', line, fn, callee })
            : line;
        const frame = `${mine[1]}.ts:${placed}`;
        if (own.at(-1) !== frame) own.push(frame);
        callee = fn;
        if (own.length === 4) break;
        continue;
      }
      if (own.length > 0) continue;
      const alias = ALIAS.exec(file);
      if (alias) {
        via ??= `${alias[1]}.ts:${line}`;
        callee = fn;
        continue;
      }
      // The first source frame is of another file (stage 4's launch): not this round's I/O.
      if (SOURCE.test(file)) return null;
    }
    if (own.length === 0) return null;
    return { site: own[0] as string, via, chain: own.join(' < ') };
  }
  const eio = (op: string, file: unknown) =>
    Object.assign(new Error(`EIO: ${op} ${String(file)} (test)`), { code: 'EIO' });
  function ask(op: string, file: unknown): Mode | null {
    const on = state.on;
    if (!on || reading) return null;
    const place = where(op);
    if (!place) {
      state.outside += 1;
      return null;
    }
    return on({ op, file: String(file), ...place });
  }
  /** A synchronous call through the trap; `partial` does part of the effect. */
  function sync<T>(op: string, file: unknown, real: () => T, partial?: () => void): T {
    const mode = ask(op, file);
    if (mode === null) return real();
    if (mode === 'before') {
      if (op === 'existsSync') return false as T;
      throw eio(op, file);
    }
    if (mode === 'partial' && partial) {
      partial();
      throw eio(op, file);
    }
    const value = real();
    if (op === 'openSync') realClose?.(value as number);
    throw eio(op, file);
  }
  /** The same for a call of `node:fs/promises`: a failure is a rejection, never a throw. */
  async function async<T>(
    op: string,
    file: unknown,
    real: () => Promise<T>,
    partial?: () => Promise<void>
  ): Promise<T> {
    const mode = ask(op, file);
    if (mode === null) return real();
    if (mode === 'before') throw eio(op, file);
    if (mode === 'partial' && partial) {
      await partial();
      throw eio(op, file);
    }
    await real();
    throw eio(op, file);
  }
  let realClose: ((fd: number) => void) | null = null;
  const half = (data: unknown) =>
    typeof data === 'string'
      ? data.slice(0, Math.floor(data.length / 2))
      : data instanceof Uint8Array
        ? data.subarray(0, Math.floor(data.length / 2))
        : data;
  /** The store's file system: `real` with every call it makes through the trap. */
  function storeFs<F extends Record<string, unknown>>(real: F): F {
    const call = (name: string) => real[name] as (...args: unknown[]) => unknown;
    realClose = (fd) => call('closeSync')(fd);
    const plain =
      (name: string) =>
      (...args: unknown[]) =>
        sync(name, args[0], () => call(name)(...args));
    const wrapped: Record<string, unknown> = { ...real };
    for (const name of [
      'existsSync',
      'readFileSync',
      'readdirSync',
      'statSync',
      'lstatSync',
      'mkdirSync',
      'linkSync',
      'openSync',
      'fsyncSync',
      'closeSync',
      'renameSync',
    ])
      wrapped[name] = plain(name);
    wrapped.writeFileSync = (...args: unknown[]) =>
      sync(
        'writeFileSync',
        args[0],
        () => call('writeFileSync')(...args),
        () => call('writeFileSync')(args[0], half(args[1]), ...args.slice(2))
      );
    wrapped.rmSync = (...args: unknown[]) =>
      sync(
        'rmSync',
        args[0],
        () => call('rmSync')(...args),
        () => {
          const target = String(args[0]);
          const names = (() => {
            try {
              return (call('readdirSync')(target) as string[]).sort();
            } catch {
              return [];
            }
          })();
          if (names[0]) call('rmSync')(`${target}/${names[0]}`, { recursive: true, force: true });
        }
      );
    return wrapped as F;
  }
  return { state, sync, async, half, storeFs };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>();
  const readFileSync = ((file: unknown, ...rest: unknown[]) => {
    const code = typeof file === 'string' ? (fsFaults.read?.(file) ?? null) : null;
    if (code) throw Object.assign(new Error(`${code}: ${String(file)} (test)`), { code });
    return io.sync('readFileSync', file, () =>
      (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest)
    );
  }) as typeof actual.readFileSync;
  const readdirSync = ((file: unknown, ...rest: unknown[]) =>
    io.sync('readdirSync', file, () =>
      (actual.readdirSync as (...args: unknown[]) => unknown)(file, ...rest)
    )) as typeof actual.readdirSync;
  const statSync = ((file: unknown, ...rest: unknown[]) =>
    io.sync('statSync', file, () =>
      (actual.statSync as (...args: unknown[]) => unknown)(file, ...rest)
    )) as typeof actual.statSync;
  const traced = { readFileSync, readdirSync, statSync };
  return { ...actual, default: { ...actual, ...traced }, ...traced };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromisesModule>();
  const realCall = (name: keyof typeof actual) =>
    actual[name] as unknown as (...args: unknown[]) => Promise<unknown>;
  const writeFile = (async (file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && fsFaults.write) await fsFaults.write(file);
    return io.async(
      'writeFile',
      file,
      () => realCall('writeFile')(file, ...rest),
      async () => {
        await realCall('writeFile')(file, io.half(rest[0]), ...rest.slice(1));
      }
    );
  }) as typeof actual.writeFile;
  const readFile = (async (file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'string' && fsFaults.readAsync) await fsFaults.readAsync(file);
    return io.async('readFile', file, () => realCall('readFile')(file, ...rest));
  }) as typeof actual.readFile;
  const rm = (async (file: unknown, ...rest: unknown[]) => {
    const real = () => (actual.rm as (...args: unknown[]) => Promise<void>)(file, ...rest);
    if (typeof file === 'string' && fsFaults.rm) return fsFaults.rm(file, real);
    return io.async('rm', file, real, async () => {
      const names = await actual.readdir(String(file)).catch(() => [] as string[]);
      const first = [...names].sort()[0];
      if (first) await actual.rm(`${String(file)}/${first}`, { recursive: true, force: true });
    });
  }) as typeof actual.rm;
  const plain = (name: 'lstat' | 'readdir' | 'realpath') =>
    (async (file: unknown, ...rest: unknown[]) =>
      io.async(name, file, () => realCall(name)(file, ...rest))) as unknown;
  const rename = (async (from: unknown, to: unknown, ...rest: unknown[]) => {
    const real = () => realCall('rename')(from, to, ...rest) as Promise<void>;
    // Round 6 (D-16): a launch directory is removed by a rename to `.removed-<id>` first; a test
    // that fails the removal of a directory (`fsFaults.rm`) fails that step.
    if (typeof from === 'string' && String(to).includes('/.removed-') && fsFaults.rm)
      return fsFaults.rm(from, real);
    return io.async('rename', from, real);
  }) as typeof actual.rename;
  const traced = {
    writeFile,
    readFile,
    rm,
    lstat: plain('lstat') as typeof actual.lstat,
    readdir: plain('readdir') as typeof actual.readdir,
    realpath: plain('realpath') as typeof actual.realpath,
    rename,
  };
  return { ...actual, default: { ...actual, ...traced }, ...traced };
});
vi.mock('./pi-conversation', async (importOriginal) => {
  const actual = await importOriginal<typeof PiConversationModule>();
  const fs = io.storeFs(
    (await vi.importActual<typeof FsModule>('node:fs')) as unknown as Record<string, unknown>
  ) as unknown as typeof FsModule;
  // R7-C: the rule of where processes are read, as the adapter passes it to its store.
  const { piProcSource } = await vi.importActual<typeof PiBashModule>('./pi-bash');
  return {
    ...actual,
    piConversationStore: (options: Parameters<typeof actual.piConversationStore>[0] = {}) =>
      actual.piConversationStore({ fs, procSource: piProcSource, ...options }),
  };
});

const realChild = await vi.importActual<typeof ChildProcessModule>('node:child_process');
const { piConversationStore, piRecoverSource } = await import('./pi-conversation');

/**
 * Round 6 (D-16): places a frame of `pi-conversation.ts` on its source line. In this file the
 * store is the original module behind a mocked id (`vi.mock('./pi-conversation')`), and its frames
 * come with the lines of the code as transformed, without the source map (the adapter's frames
 * are mapped). The transformed code of the store is its own text (`piRecoverSource` serializes the
 * very function); its offset in the module is calibrated once on a call whose place is known (the
 * `readdirSync` of `processSource`, the first `readdirSync(procRoot)` of the store). A frame's line is
 * then the line of that text, and the source line is the one making the same call (`callee(`) in
 * the same order: the n-th line calling it in the transformed text is the n-th in the source
 * (comments, which the transform drops, left out). A frame that cannot be placed is line 0, which
 * no inventory lists.
 */
const placeStoreFrame = await (async () => {
  const realFs = await vi.importActual<typeof FsModule>('node:fs');
  const all = realFs
    .readFileSync(new URL('./pi-conversation.ts', import.meta.url), 'utf8')
    .split('\n');
  const begin = all.findIndex((line) => line.startsWith('export function piConversationStore('));
  const end = all.findIndex((line) => line.startsWith('export const PI_RECOVER_SCRIPT'));
  const code = (line: string) => !/^\s*(\/\/|\*|\/\*)/.test(line);
  const text = piRecoverSource().split('\n');
  const body = text.slice(
    text.findIndex((line) => line.startsWith('const piConversationStore = '))
  );
  let seen = 0;
  const probe = {
    ...realFs,
    readdirSync: (...args: unknown[]) => {
      const found = /at processSource \(.+pi-conversation\.ts:(\d+):/.exec(
        String(new Error('calibrate').stack)
      );
      if (found) seen = Number(found[1]);
      return (realFs.readdirSync as (...a: unknown[]) => unknown)(...args);
    },
  } as unknown as typeof FsModule;
  piConversationStore({ fs: probe, procRoot: '/proc' }).processStart(process.pid);
  // Mapped after all (another runner): the line is the source's.
  if (seen > 0 && all[seen - 1]?.includes('readdirSync(procRoot)')) return null;
  const offset = seen - body.findIndex((line) => line.includes('readdirSync(procRoot)'));
  return (frame: { line: number; callee: string }): number => {
    const at = frame.line - offset;
    const call = `${frame.callee}(`;
    if (!frame.callee || !body[at]?.includes(call)) return 0;
    const nth = body.slice(0, at + 1).filter((line) => line.includes(call)).length;
    let count = 0;
    for (let index = begin; index < end; index += 1) {
      const line = all[index] as string;
      if (code(line) && line.includes(call) && (count += 1) === nth) return index + 1;
    }
    return 0;
  };
})();
io.state.place = placeStoreFrame;
const { createPiAdapter, killPiBashGroups, PiAdapter, validatePiSessionFile } =
  await import('./pi-adapter');
const { PiRpcClient } = await import('./pi-rpc');
const { PI_RUN_PREPARING_PREFIX } = await import('./pi-launch');
/**
 * U-5 (R3-E): whether `file` is a launch directory in place under `<state>/run` (not one
 * `preparePiLaunch` is making, under `PI_RUN_PREPARING_PREFIX`, nor one being removed, under
 * `.removed-`; joint round 5, O-9 A′: two names).
 */
const inPlace = (file: string) =>
  dirname(file) === join(stateDir(), 'run') &&
  !basename(file).startsWith(PI_RUN_PREPARING_PREFIX) &&
  !basename(file).startsWith('.removed-');
/** U-5: the launch directories in place. */
const launchesInPlace = () => {
  const run = join(stateDir(), 'run');
  return existsSync(run)
    ? readdirSync(run)
        .map((name) => join(run, name))
        .filter(inPlace)
    : [];
};
/** The procfs start time of this process, the host of every adapter here (R3-A). */
const hostStart = () => piConversationStore().ownIdentity().start;
/** A start time this process does not have, one tick after its own: a host that is gone. */
const deadHostStart = () => String(BigInt(hostStart() ?? '0') + 1n);

const MODEL = 'fake/fake-model';
const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(check: () => boolean, what: string, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function argAfter(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

/** What every FakePi answers as Pi with the bridge loaded would. */
function standardPi(pi: FakePi, entry: Spawned): void {
  const nonce = entry.config?.nonce;
  const bridge = argAfter(entry.args, '-e') ?? '';
  const file = argAfter(entry.args, '--session');
  const id = file ? /_([^_]+)\.jsonl$/.exec(file)?.[1] : argAfter(entry.args, '--session-id');
  const sessionDir = argAfter(entry.args, '--session-dir') ?? '';
  pi.handlers.set('get_commands', () => ({
    data: {
      commands: nonce
        ? [{ name: `switch-hello-${nonce}`, source: 'extension', sourceInfo: { path: bridge } }]
        : [],
    },
  }));
  pi.handlers.set('get_state', () => ({
    data: fakePiState({
      sessionId: id,
      sessionFile: file ?? join(sessionDir, `2026-11-03T10-00-00-000Z_${id}.jsonl`),
      // As Pi's `get_state` (`rpc-mode.js:345-358`): the model it runs now.
      model: runningModels.get(pi) ?? FAKE_PI_MODEL,
    }),
  }));
  pi.handlers.set('get_available_models', () => ({ data: { models: [FAKE_PI_MODEL] } }));
  pi.handlers.set('abort', () => ({ data: undefined }));
  pi.handlers.set('set_model', (command) => {
    if (command.provider !== 'fake' || command.modelId !== 'other-model')
      return { error: `Model not found: ${String(command.provider)}/${String(command.modelId)}` };
    runningModels.set(pi, { ...FAKE_PI_MODEL, id: 'other-model' });
    return { data: { ...FAKE_PI_MODEL, id: 'other-model' } };
  });
  // `prompt` is scripted per test; by default a run is announced and started, nothing more.
  pi.handlers.set('prompt', () => {
    announce(pi, entry, nextRun(pi));
    return { data: { disposition: 'started' } };
  });
}

/** The model each FakePi runs once a `set_model` changed it. */
const runningModels = new WeakMap<FakePi, Record<string, unknown>>();
const runs = new WeakMap<FakePi, number>();
function nextRun(pi: FakePi): number {
  const run = (runs.get(pi) ?? 0) + 1;
  runs.set(pi, run);
  return run;
}
function announce(pi: FakePi, entry: Spawned, run: number): void {
  pi.emitRecord({
    type: 'extension_ui_request',
    id: `n-${run}-${Math.random()}`,
    method: 'notify',
    message: `switch:${entry.config?.nonce}:run:${run}`,
    notifyType: 'info',
  });
}
/** A `confirm` as the bridge sends it (`bridge.ts` `PiBridgeConfirmMessage`). */
function confirm(
  pi: FakePi,
  entry: Spawned,
  options: {
    id: string;
    run: number;
    toolCallId: string;
    toolName?: string;
    input?: unknown;
    nonce?: string;
    server?: unknown;
  }
): void {
  const nonce = options.nonce ?? entry.config?.nonce;
  pi.emitRecord({
    type: 'extension_ui_request',
    id: options.id,
    method: 'confirm',
    title: `switch:${nonce}:run:${options.run}`,
    message: JSON.stringify({
      protocolVersion: 1,
      nonce,
      run: options.run,
      toolCallId: options.toolCallId,
      parentToolCallId: null,
      toolName: options.toolName ?? 'bash',
      server: options.server ?? null,
      input: options.input ?? { command: 'echo hi' },
    }),
  });
}
function toolStart(
  pi: FakePi,
  toolCallId: string,
  toolName = 'bash',
  args: unknown = { command: 'echo hi' }
) {
  pi.emitRecord({ type: 'tool_execution_start', toolCallId, toolName, args });
}
function toolEnd(pi: FakePi, toolCallId: string, toolName = 'bash', isError = false) {
  pi.emitRecord({
    type: 'tool_execution_end',
    toolCallId,
    toolName,
    result: { content: [{ type: 'text', text: isError ? 'switch: not approved' : 'hi' }] },
    isError,
  });
}
function settle(pi: FakePi, aborted = false) {
  pi.emitRecord({ type: 'agent_end', messages: [], willRetry: false });
  pi.emitRecord({ type: 'agent_settled', aborted });
}
function uiResponses(pi: FakePi): FakePiCommand[] {
  return pi.received.filter((command) => command.type === 'extension_ui_response');
}
function prompts(pi: FakePi): FakePiCommand[] {
  return pi.received.filter((command) => command.type === 'prompt');
}

let home: string;
let events: ProviderRuntimeEvent[];
let adapters: InstanceType<typeof PiAdapter>[];
const groups: number[] = [];

function input(overrides: Partial<ProviderSessionStartInput> = {}): ProviderSessionStartInput {
  return {
    sessionId: `s-${Math.random().toString(36).slice(2)}`,
    cwd: join(home, 'project'),
    runtimeMode: 'approval-required',
    model: { id: MODEL },
    env: { HOME: home, PATH: `${join(home, 'bin')}:/usr/bin:/bin` },
    mcpServers: { switch: { transport: 'http', url: 'http://127.0.0.1:1/mcp' } },
    connectorMcpServers: [],
    ...overrides,
  };
}
function adapter(options: ConstructorParameters<typeof PiAdapter>[0] = {}) {
  const made = new PiAdapter({ cleanupTimeoutMs: 600, ...options });
  made.subscribe((event) => events.push(event));
  adapters.push(made);
  return made;
}
function of<T extends ProviderRuntimeEvent['type']>(type: T, sessionId?: string) {
  return events.filter(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> =>
      event.type === type && (sessionId === undefined || event.sessionId === sessionId)
  );
}
function completed(turnId: string) {
  return of('turn.completed').filter((event) => event.turnId === turnId);
}
function last(): Spawned {
  const entry = spawned.at(-1);
  if (!entry) throw new Error('no Pi was spawned');
  return entry;
}
function stateDir() {
  return join(home, '.local', 'state', 'switch', 'pi');
}
function sessionDir() {
  return join(stateDir(), 'sessions');
}

/**
 * U-8 (FAP-10): the markers of this run of the file. With procfs the adapter kills every live
 * process whose environment carries a marker its registry names (`killPiBashGroups`), and the
 * `setsid` test looks for its escapees by marker in all of `/proc`: with markers of their own, two
 * runs at once (two `vitest` on one machine) never see, count or kill each other's decoys.
 */
const RUN_TAG = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const tagged = (marker: string) => `${marker}@${RUN_TAG}`;

/** A real process group as the bridge's `bash` makes one: its own session, the marker in its environment. */
function startGroup(script: string, marker: string): { pid: number; starttime: string } {
  const child = realChild.spawn('/bin/sh', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', SWITCH_PI_TC: tagged(marker) },
  });
  child.unref();
  const pid = child.pid as number;
  groups.push(pid);
  const stat = readPiProcStat(pid);
  if (!stat) throw new Error('test group did not start');
  return { pid, starttime: stat.starttime };
}
/** Writes the registry records the bridge writes for one shell (`pi-bash.ts`). */
function register(
  registry: string,
  group: { pid: number; starttime: string },
  options: { toolCallId: string; run: number; marker: string; instance?: string }
): void {
  const base = {
    v: 1,
    instance: options.instance ?? 'i-1',
    toolCallId: options.toolCallId,
    run: options.run,
    marker: tagged(options.marker),
  };
  writeFileSync(
    registry,
    `${JSON.stringify({ ...base, event: 'intent' })}\n${JSON.stringify({ ...base, event: 'spawn', pid: group.pid, pgid: group.pid, starttime: group.starttime })}\n`,
    { flag: 'a' }
  );
}
/** A stand-in for a Pi that did not exit: a live process carrying its launch's `SWITCH_PI_BRIDGE`. */
function startStuckPi(bridgeConfig: string): { pid: number } {
  const child = realChild.spawn('/bin/sleep', ['60'], {
    detached: true,
    stdio: 'ignore',
    env: { PATH: '/usr/bin:/bin', SWITCH_PI_BRIDGE: bridgeConfig },
  });
  child.unref();
  const pid = child.pid as number;
  groups.push(pid);
  return { pid };
}
/** Conversations whose lock (`<X>.lock/`, its highest `<n>.owner`) is held: not released. */
function heldLocks(): string[] {
  const dir = sessionDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.lock'))
    .filter((name) => {
      const lock = join(dir, name);
      const top = Math.max(
        0,
        ...readdirSync(lock)
          .map((entry) => /^(\d+)\.owner$/.exec(entry)?.[1])
          .filter((n): n is string => n !== undefined)
          .map(Number)
      );
      return top > 0 && !existsSync(join(lock, `${top}.released`));
    });
}
function liveMembers(pgid: number): number {
  let count = 0;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = readPiProcStat(Number(entry));
    if (stat && stat.pgrp === pgid && stat.state !== 'Z') count += 1;
  }
  return count;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-adapter-'));
  mkdirSync(join(home, 'bin'));
  mkdirSync(join(home, 'project'));
  writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\necho 1.4.0\n', { mode: 0o755 });
  events = [];
  adapters = [];
  spawned.length = 0;
  configure = () => {};
  fsFaults.read = null;
  fsFaults.write = null;
  fsFaults.readAsync = null;
  fsFaults.rm = null;
  io.state.on = null;
});

afterEach(async () => {
  vi.restoreAllMocks();
  fsFaults.readAsync = null;
  fsFaults.rm = null;
  io.state.on = null;
  for (const made of adapters) await made.stopAll();
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
  rmSync(home, { recursive: true, force: true });
});

async function started(made = adapter(), overrides: Partial<ProviderSessionStartInput> = {}) {
  const given = input(overrides);
  const session = await made.startSession(given);
  return { made, given, session, entry: last() };
}

describe('the Pi adapter: start (argv, handshake, models)', () => {
  it('is what the registry builds, with Pi’s capabilities, and builds without starting Pi', () => {
    const made = createPiAdapter({});
    expect(made.provider).toBe('pi');
    expect(made.capabilities).toEqual({
      modelSwitchInSession: true,
      steering: false,
      resume: true,
      approvals: true,
      userInput: false,
    });
    expect(spawned).toHaveLength(0);
  });

  it('starts Pi with exactly the arguments of pi-args.ts: -ne, the bridge first, builtin:mcp, nothing else (D-4 A, D-7 A)', async () => {
    const { session, entry, given } = await started();
    const bridge = join(
      stateDir(),
      readdirSync(stateDir()).find((name) => name.startsWith('bridge-')) as string
    );
    expect(entry.command).toBe(join(home, 'bin', 'pi'));
    expect(entry.args).toEqual(
      piArgs({
        kind: 'session',
        bridgePath: bridge,
        sessionDir: sessionDir(),
        session: { id: session.nativeSessionId },
        model: MODEL,
      })
    );
    expect(entry.args.slice(0, 9)).toEqual([
      '--mode',
      'rpc',
      '--offline',
      '-ne',
      '-e',
      bridge,
      '-e',
      'builtin:mcp',
      '--no-approve',
    ]);
    expect(entry.args.filter((arg) => arg === '-e')).toHaveLength(2);
    expect(entry.args).not.toContain('--raw');
    expect(entry.options.cwd).toBe(given.cwd);
    expect(entry.options.env?.PI_CODING_AGENT_DIR).toBe(join(stateDir(), 'agent'));
    expect(entry.options.env?.SWITCH_PI_BRIDGE).toBe(
      join(dirname(entry.config!.processRegistry), 'config.json')
    );
    expect(Object.keys(entry.config!.mcpServers)).toEqual(['switch']);
    expect(session.nativeSessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(argAfter(entry.args, '--session-id')).toBe(session.nativeSessionId);
    expect(of('session.started')[0]).toMatchObject({ nativeSessionId: session.nativeSessionId });
    // The handshake, the session and the model are checked before anything else is sent.
    expect(entry.pi.received.map((command) => command.type)).toEqual([
      'get_commands',
      'get_state',
      'get_available_models',
    ]);
  });

  it('sends no prompt and does not start when the bridge never answers the handshake', async () => {
    configure = (pi) => pi.handlers.set('get_commands', () => ({ data: { commands: [] } }));
    const made = adapter();
    const given = input();
    await expect(made.startSession(given)).rejects.toThrow(
      /bridge did not load in Pi \(no handshake\)/
    );
    expect(made.hasSession(given.sessionId)).toBe(false);
    expect(prompts(last().pi)).toHaveLength(0);
    await expect(
      made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'hi' })
    ).rejects.toBeInstanceOf(ProviderSessionError);
    expect(prompts(last().pi)).toHaveLength(0);
    // The launch's own directory is gone, and the conversation's lock is released.
    expect(existsSync(dirname(last().config!.processRegistry))).toBe(false);
    expect(heldLocks()).toEqual([]);
  });

  it('does not take a handshake of another nonce, or one that is not an extension command', async () => {
    configure = (pi, entry) =>
      pi.handlers.set('get_commands', () => ({
        data: {
          commands: [
            { name: `switch-hello-${entry.config!.nonce}x`, source: 'extension' },
            { name: `switch-hello-${entry.config!.nonce}`, source: 'prompt' },
          ],
        },
      }));
    await expect(adapter().startSession(input())).rejects.toThrow(/no handshake/);
  });

  it('refuses a session without a model before anything starts (Q4 A)', async () => {
    const made = adapter();
    await expect(made.startSession(input({ model: undefined }))).rejects.toThrow(/needs a model/);
    expect(spawned).toHaveLength(0);
  });

  it('refuses a model Pi does not confirm in get_state, or cannot use (ER-08)', async () => {
    configure = (pi) => {
      const answer = pi.handlers.get('get_state')!;
      pi.handlers.set('get_state', (command) => {
        const reply = answer(command) as { data: Record<string, unknown> };
        return { data: { ...reply.data, model: { ...FAKE_PI_MODEL, id: 'fake-model-2' } } };
      });
    };
    await expect(adapter().startSession(input())).rejects.toThrow(
      /Pi runs fake\/fake-model-2, not fake\/fake-model/
    );
    configure = (pi) =>
      pi.handlers.set('get_state', () => ({ data: fakePiState({ sessionId: 'someone-else' }) }));
    await expect(adapter().startSession(input())).rejects.toThrow(
      /Pi opened conversation "someone-else"/
    );
    configure = (pi) => pi.handlers.set('get_available_models', () => ({ data: { models: [] } }));
    await expect(adapter().startSession(input())).rejects.toThrow(
      /no model fake\/fake-model it can use/
    );
    expect(spawned.every((entry) => prompts(entry.pi).length === 0)).toBe(true);
  });

  it('turns launch refusals into ProviderSessionError (binary, version, profile)', async () => {
    const relative = adapter({ binaryPath: 'bin/pi' });
    await expect(relative.startSession(input())).rejects.toSatisfy(
      (error) => error instanceof ProviderSessionError && /absolute path/.test(String(error))
    );
    writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\necho 1.4.1\n', { mode: 0o755 });
    await expect(adapter().startSession(input())).rejects.toSatisfy(
      (error) => error instanceof ProviderSessionError && /1\.4\.0/.test(String(error))
    );
    writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\necho 1.4.0\n', { mode: 0o755 });
    mkdirSync(join(stateDir(), 'agent'), { recursive: true });
    writeFileSync(join(stateDir(), 'agent', 'models.json'), '{}');
    await expect(adapter().startSession(input())).rejects.toSatisfy(
      (error) => error instanceof ProviderSessionError && /models\.json/.test(String(error))
    );
    expect(spawned).toHaveLength(0);
  });

  it('discovers models with a Pi that keeps no conversation, and runs no turn there (ER-08, P-12)', async () => {
    const made = adapter();
    const given = input({ model: undefined, mcpServers: {} });
    const session = await made.startSession(given);
    const entry = last();
    expect(entry.args).toEqual(
      piArgs({ kind: 'discovery', bridgePath: argAfter(entry.args, '-e') as string })
    );
    expect(entry.args).toContain('--no-session');
    expect(entry.options.env?.SWITCH_PI_BRIDGE).toBeUndefined();
    expect(session.nativeSessionId).toBe('');
    expect(await made.listModels(given.sessionId)).toEqual([
      { id: 'fake/fake-model', label: 'Fake Model (fake)', options: {}, imageInput: false },
    ]);
    await expect(
      made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'hi' })
    ).rejects.toThrow(/needs a model/);
    expect(prompts(entry.pi)).toHaveLength(0);
    await made.stopSession(given.sessionId);
    expect(existsSync(sessionDir())).toBe(false);
    expect(existsSync(join(stateDir(), 'run'))).toBe(false);
  });
});

describe('the Pi adapter: turns and the queue (SC10, ER-02)', () => {
  it('runs a turn bound to the run the bridge announced, with the events held from the prompt', async () => {
    configure = (pi, entry) =>
      pi.handlers.set('prompt', (command) => {
        // A compaction before the run: written after the prompt, before the announcement.
        pi.emitRecord({ type: 'compaction_start', reason: 'threshold' });
        pi.emitRecord({
          type: 'compaction_end',
          reason: 'threshold',
          result: { summary: 's', tokensBefore: 10 },
          aborted: false,
          willRetry: false,
        });
        announce(pi, entry, nextRun(pi));
        setImmediate(() => pi.emitRecords(fakePiTextTurn(String(command.message), 'hello')));
        return { data: { disposition: 'started' } };
      });
    const { made, given } = await started();
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'turn-1', text: 'hi' });
    await until(() => completed('turn-1').length === 1, 'turn-1');
    expect(of('turn.started').map((event) => event.turnId)).toEqual(['turn-1']);
    expect(of('content.delta').map((event) => event.delta)).toEqual(['hello']);
    expect(
      of('item.completed').some(
        (event) => event.item.type === 'context_compaction' && event.turnId === 'turn-1'
      )
    ).toBe(true);
    expect(completed('turn-1')[0]).toMatchObject({
      outcome: 'completed',
      usage: [{ model: 'fake-model', inputTokens: 11, outputTokens: 7 }],
    });
  });

  it('queues a turn sent mid-turn and starts it, with its own turnId, after agent_settled', async () => {
    const { made, given, entry } = await started();
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'a', text: 'first' });
    await until(() => prompts(entry.pi).length === 1, 'prompt a');
    const second = await made.sendTurn({ sessionId: given.sessionId, turnId: 'b', text: 'second' });
    expect(second).toEqual({ turnId: 'b' });
    await tick();
    expect(prompts(entry.pi)).toHaveLength(1);
    entry.pi.emitRecords(fakePiTextTurn('first', 'one').slice(0, -1)); // up to agent_end
    await tick();
    expect(prompts(entry.pi)).toHaveLength(1);
    entry.pi.emitRecord({ type: 'agent_settled', aborted: false });
    await until(() => prompts(entry.pi).length === 2, 'prompt b');
    expect(prompts(entry.pi)[1]?.message).toBe('second');
    entry.pi.emitRecords(fakePiTextTurn('second', 'two'));
    await until(() => completed('b').length === 1, 'turn b');
    expect(completed('a')).toHaveLength(1);
    expect(of('content.delta').map((event) => [event.turnId, event.delta])).toEqual([
      ['a', 'one'],
      ['b', 'two'],
    ]);
  });

  it.each([
    [
      'handled',
      (pi: FakePi) => pi.handlers.set('prompt', () => ({ data: { disposition: 'handled' } })),
      'completed',
    ],
    [
      'a preflight failure (no key)',
      (pi: FakePi) => pi.handlers.set('prompt', () => ({ error: 'No API key found for fake.' })),
      'error',
    ],
    [
      'a failure after before_agent_start (the run is spent)',
      (pi: FakePi, entry: Spawned) =>
        pi.handlers.set('prompt', () => {
          announce(pi, entry, nextRun(pi));
          return { error: 'image could not be prepared' };
        }),
      'error',
    ],
  ] as const)('ends the turn on %s, and the next turn runs', async (_name, script, outcome) => {
    const { made, given, entry } = await started();
    script(entry.pi, entry);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'one', text: 'x' });
    await until(() => completed('one').length === 1, 'turn one');
    expect(completed('one')[0]?.outcome).toBe(outcome);
    // The host retries a failed turn as a new turn (`message.retry`); it runs on the next run.
    standardPi(entry.pi, entry);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'two', text: 'y' });
    await until(() => prompts(entry.pi).length === 2, 'prompt two');
    entry.pi.emitRecords(fakePiTextTurn('y', 'ok'));
    await until(() => completed('two').length === 1, 'turn two');
    expect(completed('two')[0]?.outcome).toBe('completed');
  });

  it('ends the turn when Pi exits mid-turn, and the session with it', async () => {
    const { made, given, entry } = await started();
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    entry.pi.exit(1, null);
    await until(() => of('session.exited').length === 1, 'exit');
    expect(completed('t')[0]).toMatchObject({ outcome: 'error' });
    expect(made.hasSession(given.sessionId)).toBe(false);
  });

  it('sends the system context before the first turn only, and never a text Pi would run as a command', async () => {
    const { made, given, entry } = await started(adapter(), { systemContext: 'CONTEXT' });
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'a', text: 'hi' });
    await until(() => prompts(entry.pi).length === 1, 'a');
    expect(prompts(entry.pi)[0]?.message).toBe('CONTEXT\n\nhi');
    entry.pi.emitRecords(fakePiTextTurn('hi', 'x'));
    await until(() => completed('a').length === 1, 'a done');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'b', text: '/compact now' });
    await until(() => prompts(entry.pi).length === 2, 'b');
    expect(prompts(entry.pi)[1]?.message).toBe(' /compact now');
  });

  it('switches the model with set_model before the prompt when the turn names another (ER-08)', async () => {
    const { made, given, entry } = await started();
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'a',
      text: 'hi',
      model: { id: 'fake/other-model' },
    });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const types = entry.pi.received.map((command) => command.type);
    expect(types.indexOf('set_model')).toBeLessThan(types.indexOf('prompt'));
    expect(entry.pi.received.find((command) => command.type === 'set_model')).toMatchObject({
      provider: 'fake',
      modelId: 'other-model',
    });
    entry.pi.emitRecords(fakePiTextTurn('hi', 'x'));
    await until(() => completed('a').length === 1, 'a');
    // A model Pi refuses ends the turn before any prompt.
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'b',
      text: 'hi',
      model: { id: 'fake/missing' },
    });
    await until(() => completed('b').length === 1, 'b');
    expect(completed('b')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/could not switch to fake\/missing/),
    });
    expect(prompts(entry.pi)).toHaveLength(1);
  });
});

describe('the Pi adapter: approvals (SC11, READY §2.2 rule 1)', () => {
  async function running() {
    const ctx = await started();
    await ctx.made.sendTurn({ sessionId: ctx.given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(ctx.entry.pi).length === 1, 'prompt');
    await tick();
    return ctx;
  }

  it('opens a card for a call of the bound run and passes the answer to Pi', async () => {
    const { made, given, entry } = await running();
    toolStart(entry.pi, 'call-1');
    confirm(entry.pi, entry, { id: 'ui-1', run: 1, toolCallId: 'call-1' });
    await until(() => of('request.opened').length === 1, 'card');
    const card = of('request.opened')[0]!;
    expect(card).toMatchObject({
      turnId: 't',
      requestType: 'command_execution_approval',
      detail: 'echo hi',
    });
    expect(card.options.map((option) => option.decision)).toEqual(['accept', 'decline', 'cancel']);
    await made.respondToRequest(given.sessionId, card.requestId, 'accept');
    await until(() => uiResponses(entry.pi).length === 1, 'answer');
    expect(uiResponses(entry.pi)[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      confirmed: true,
    });
  });

  it('declines with confirmed:false and ends the item declined', async () => {
    const { made, given, entry } = await running();
    toolStart(entry.pi, 'call-1');
    confirm(entry.pi, entry, { id: 'ui-1', run: 1, toolCallId: 'call-1' });
    await until(() => of('request.opened').length === 1, 'card');
    await made.respondToRequest(given.sessionId, of('request.opened')[0]!.requestId, 'decline');
    await until(() => uiResponses(entry.pi).length === 1, 'answer');
    expect(uiResponses(entry.pi)[0]).toMatchObject({ id: 'ui-1', confirmed: false });
    toolEnd(entry.pi, 'call-1', 'bash', true);
    await until(() => of('item.completed').length === 1, 'item');
    expect(of('item.completed')[0]?.item.status).toBe('declined');
  });

  it('cancels an open card on interrupt; a late answer unblocks nothing', async () => {
    const { made, given, entry } = await running();
    toolStart(entry.pi, 'call-1');
    confirm(entry.pi, entry, { id: 'ui-1', run: 1, toolCallId: 'call-1' });
    await until(() => of('request.opened').length === 1, 'card');
    const { requestId } = of('request.opened')[0]!;
    await made.interruptTurn(given.sessionId);
    await until(() => uiResponses(entry.pi).length === 1, 'cancel');
    expect(uiResponses(entry.pi)[0]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });
    expect(of('request.resolved')).toEqual([
      expect.objectContaining({ requestId, decision: 'cancel' }),
    ]);
    expect(entry.pi.received.some((command) => command.type === 'abort')).toBe(true);
    await expect(made.respondToRequest(given.sessionId, requestId, 'accept')).rejects.toThrow(
      /No pending approval/
    );
    await tick();
    expect(uiResponses(entry.pi)).toHaveLength(1);
    // A call asked about after the interrupt gets no card either.
    confirm(entry.pi, entry, { id: 'ui-2', run: 1, toolCallId: 'call-2' });
    await until(() => uiResponses(entry.pi).length === 2, 'second cancel');
    expect(uiResponses(entry.pi)[1]).toEqual({
      type: 'extension_ui_response',
      id: 'ui-2',
      cancelled: true,
    });
    expect(of('request.opened')).toHaveLength(1);
    toolEnd(entry.pi, 'call-1', 'bash', true);
    settle(entry.pi, true);
    await until(() => completed('t').length === 1, 'turn');
    expect(completed('t')[0]?.outcome).toBe('interrupted');
  });

  it.each([
    ['another run', { run: 2 }],
    ['another nonce', { nonce: 'Z'.repeat(32) }],
  ] as const)(
    'cancels a request of %s without a card, and its item ends declined',
    async (_name, change) => {
      const { entry } = await running();
      toolStart(entry.pi, 'call-x');
      confirm(entry.pi, entry, { id: 'ui-x', run: 1, toolCallId: 'call-x', ...change });
      await until(() => uiResponses(entry.pi).length === 1, 'cancel');
      expect(uiResponses(entry.pi)[0]).toEqual({
        type: 'extension_ui_response',
        id: 'ui-x',
        cancelled: true,
      });
      expect(of('request.opened')).toHaveLength(0);
      toolEnd(entry.pi, 'call-x', 'bash', true);
      await until(() => of('item.completed').length === 1, 'item');
      expect(of('item.completed')[0]?.item.status).toBe('declined');
    }
  );

  it('cancels a request before the run is bound, and one with no turn at all', async () => {
    const { made, given, entry } = await started();
    confirm(entry.pi, entry, { id: 'idle', run: 1, toolCallId: 'c0' });
    await until(() => uiResponses(entry.pi).length === 1, 'idle cancel');
    entry.pi.handlers.set('prompt', () => {
      confirm(entry.pi, entry, { id: 'early', run: 1, toolCallId: 'c1' });
      return undefined;
    });
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => uiResponses(entry.pi).length === 2, 'early cancel');
    expect(uiResponses(entry.pi).map((response) => response.cancelled)).toEqual([true, true]);
    expect(of('request.opened')).toHaveLength(0);
  });

  it('allows without a card what the policy allows: a read, an auto-approved MCP server', async () => {
    const { entry } = await running();
    confirm(entry.pi, entry, {
      id: 'ui-r',
      run: 1,
      toolCallId: 'r',
      toolName: 'read',
      input: { path: 'a.txt' },
    });
    confirm(entry.pi, entry, {
      id: 'ui-m',
      run: 1,
      toolCallId: 'm',
      toolName: 'mcp__switch__post',
      input: {},
      server: { namespace: 'mcp__switch', aliases: ['switch'], sourcePath: 'builtin:mcp' },
    });
    await until(() => uiResponses(entry.pi).length === 2, 'answers');
    expect(uiResponses(entry.pi).map((response) => response.confirmed)).toEqual([true, true]);
    expect(of('request.opened')).toHaveLength(0);
  });

  it('refuses Pi’s other dialogs (an MCP sign-in) instead of showing them', async () => {
    const { entry } = await started();
    for (const method of ['select', 'input', 'editor'])
      entry.pi.emitRecord({
        type: 'extension_ui_request',
        id: `d-${method}`,
        method,
        title: 'MCP server',
      });
    await until(() => uiResponses(entry.pi).length === 3, 'refusals');
    expect(uiResponses(entry.pi).every((response) => response.cancelled === true)).toBe(true);
    expect(of('user-input.requested')).toHaveLength(0);
  });

  it('ignores the events and requests of a Pi it stopped (an interrupt that did not settle)', async () => {
    const made = adapter({ interruptTimeoutMs: 50 });
    const { given, entry } = await started(made);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    await made.interruptTurn(given.sessionId);
    await until(() => completed('t1').length === 1, 'forced interrupt');
    expect(completed('t1')[0]?.outcome).toBe('interrupted');
    expect(entry.pi.signals).toContain('SIGTERM');
    const before = events.length;
    entry.pi.emitRecords(fakePiTextTurn('x', 'late'));
    confirm(entry.pi, entry, { id: 'old', run: 1, toolCallId: 'old-call' });
    await tick();
    await tick();
    expect(events.length).toBe(before);
    // The next turn runs in a new Pi (a new generation) on the same conversation.
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'y' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    expect(argAfter(last().args, '--session-id')).toBe(argAfter(entry.args, '--session-id'));
    expect(last().config!.nonce).not.toBe(entry.config!.nonce);
    last().pi.emitRecords(fakePiTextTurn('y', 'ok'));
    await until(() => completed('t2').length === 1, 't2');
    expect(completed('t2')[0]?.outcome).toBe('completed');
  });
});

describe('the Pi adapter: processes (SC12, ER-06, Q1 A, D-10 A5)', () => {
  it('stop kills every registered group of the session and removes the launch directory', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    const earlier = startGroup('sleep 60 & sleep 0.3', 'm-early');
    const current = startGroup('sleep 60', 'm-now');
    register(registry, earlier, { toolCallId: 'c1', run: 1, marker: 'm-early' });
    register(registry, current, { toolCallId: 'c2', run: 2, marker: 'm-now' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(liveMembers(earlier.pid)).toBe(1); // the shell ended, its background sleep did not
    await made.stopSession(given.sessionId);
    expect(liveMembers(earlier.pid)).toBe(0);
    expect(liveMembers(current.pid)).toBe(0);
    expect(existsSync(dirname(registry))).toBe(false);
    expect(of('session.exited')).toHaveLength(1);
  });

  it('interrupt kills only the groups of the current run and reports the ones left', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const earlier = startGroup('sleep 60', 'm-a');
    const current = startGroup('sleep 60', 'm-b');
    register(registry, earlier, { toolCallId: 'old', run: 0, marker: 'm-a' });
    register(registry, current, { toolCallId: 'now', run: 1, marker: 'm-b' });
    await made.interruptTurn(given.sessionId);
    settle(entry.pi, true);
    await until(() => completed('t').length === 1, 'turn');
    await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
    expect(liveMembers(current.pid)).toBe(0);
    expect(liveMembers(earlier.pid)).toBeGreaterThan(0);
    expect(
      of('runtime.warning')
        .map((event) => event.message)
        .join('\n')
    ).toMatch(/1 command\(s\) started earlier .* still run/);
    expect(made.hasBackgroundWork(given.sessionId)).toBe(true);
    await made.stopSession(given.sessionId);
    expect(liveMembers(earlier.pid)).toBe(0);
  });

  it('blocks the next turn while the cleanup of an interrupt is not confirmed, and lets it run once it is', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    // The shell's child dropped the marker (`env -i`): the group cannot be verified, so it is not killed.
    const stubborn = startGroup('env -i /bin/sleep 60 & sleep 0.3', 'm-s');
    register(registry, stubborn, { toolCallId: 'now', run: 1, marker: 'm-s' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await made.interruptTurn(given.sessionId);
    settle(entry.pi, true);
    await until(() => of('session.state.changed').at(-1)?.status === 'error', 'blocked');
    expect(
      of('runtime.warning')
        .map((event) => event.message)
        .join('\n')
    ).toMatch(/could not confirm .* state is unknown/);
    await expect(
      made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' })
    ).rejects.toThrow(/could not confirm/);
    expect(prompts(entry.pi)).toHaveLength(1);
    expect(liveMembers(stubborn.pid)).toBe(1);
    process.kill(-stubborn.pid, 'SIGKILL');
    await until(() => liveMembers(stubborn.pid) === 0, 'manual kill');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' });
    await until(() => prompts(entry.pi).length === 2, 'next prompt');
  });

  it('refuses to start the conversation again while the cleanup of its stop is not confirmed', async () => {
    const made = adapter();
    const { given, entry, session } = await started(made);
    const stubborn = startGroup('env -i /bin/sleep 60 & sleep 0.3', 'm-t');
    register(entry.config!.processRegistry, stubborn, { toolCallId: 'c', run: 1, marker: 'm-t' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await made.stopSession(given.sessionId);
    expect(existsSync(dirname(entry.config!.processRegistry))).toBe(true);
    // The conversation has a transcript to resume (Pi writes it with the first message).
    writeTranscript(session.nativeSessionId, given.cwd);
    const resume = { ...input({ resume: { nativeSessionId: session.nativeSessionId } }) };
    await expect(made.startSession(resume)).rejects.toThrow(/could not confirm/);
    expect(spawned).toHaveLength(1);
    process.kill(-stubborn.pid, 'SIGKILL');
    await until(() => liveMembers(stubborn.pid) === 0, 'manual kill');
    await made.startSession({ ...resume, sessionId: `${resume.sessionId}-2` });
    expect(spawned).toHaveLength(2);
    expect(existsSync(dirname(entry.config!.processRegistry))).toBe(false);
  });

  it('D-10 A5: Pi dies mid-command (unwritable TMPDIR, long output): a clear error, and the orphaned group is killed', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    toolStart(entry.pi, 'call-big', 'bash', { command: 'seq 1 100000; sleep 12' });
    // The bridge recorded `intent` and `spawn` and nothing more (`p1_d10_probe.md` finding 3).
    const orphan = startGroup('sleep 60', 'm-big');
    register(registry, orphan, { toolCallId: 'call-big', run: 1, marker: 'm-big' });
    entry.pi.stderr.write(
      "node:events:497\n      throw er; // Unhandled 'error' event\nError: EACCES: permission denied, open '/tmp/ro/pi-bash-6a1f.log'\n"
    );
    entry.pi.exit(1, null);
    await until(() => of('session.exited').length === 1, 'exit');
    const end = completed('t')[0];
    expect(end?.outcome).toBe('error');
    expect(end?.message).toMatch(/stopped unexpectedly while running bash/);
    expect(end?.message).toMatch(/TMPDIR/);
    expect(end?.message).toMatch(/EACCES: permission denied/);
    expect(
      of('item.completed').find(
        (event) => event.item.id.includes('call-big') || event.item.title.includes('seq')
      )?.item.status
    ).toBe('failed');
    expect(liveMembers(orphan.pid)).toBe(0);
    expect(existsSync(dirname(registry))).toBe(false);
  });

  it('kills a shell recorded as intended but not as spawned (Pi died in between), found by its marker', async () => {
    const registry = join(home, 'reg.jsonl');
    const hidden = startGroup('sleep 60', 'm-intent');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, instance: 'i', toolCallId: 'c', run: 1, marker: tagged('m-intent'), event: 'intent' })}\n`
    );
    const result = await killPiBashGroups(registry, () => true, {
      includeUnspawned: true,
      timeoutMs: 600,
      since: hostStart(),
    });
    expect(result.confirmed).toBe(true);
    expect(liveMembers(hidden.pid)).toBe(0);
  });
});

function writeTranscript(id: string, cwd: string, lines?: unknown[], raw?: string): string {
  mkdirSync(sessionDir(), { recursive: true });
  const file = join(sessionDir(), `2026-11-03T10-00-00-000Z_${id}.jsonl`);
  const entries = lines ?? [
    { type: 'session', version: 3, id, timestamp: '2026-11-03T10:00:00.000Z', cwd },
    { type: 'message', id: 'a1', parentId: null, message: { role: 'user', content: 'hi' } },
    { type: 'message', id: 'a2', parentId: 'a1', message: { role: 'assistant', content: [] } },
  ];
  writeFileSync(file, raw ?? `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`);
  return file;
}

describe('the Pi adapter: resume (SC13, ER-07, Q2 A′)', () => {
  const ID = '0199a5c0-0000-7000-8000-000000000001';

  it('resumes a transcript it checked, with --session <file>, and returns the same id', async () => {
    const made = adapter();
    const file = writeTranscript(ID, join(home, 'project'));
    const session = await made.startSession(input({ resume: { nativeSessionId: ID } }));
    expect(session.nativeSessionId).toBe(ID);
    expect(argAfter(last().args, '--session')).toBe(file);
    expect(last().args).not.toContain('--session-id');
  });

  const header = (cwd: string, extra: Record<string, unknown> = {}) => ({
    type: 'session',
    version: 3,
    id: ID,
    timestamp: 't',
    cwd,
    ...extra,
  });
  const msg = (id: string, parentId: string | null, extra: Record<string, unknown> = {}) => ({
    type: 'message',
    id,
    parentId,
    message: { role: 'user', content: 'x' },
    ...extra,
  });
  const cases: Array<[string, (cwd: string) => { lines?: unknown[]; raw?: string }, RegExp]> = [
    [
      'a broken line in the middle',
      (cwd) => ({
        raw: `${JSON.stringify(header(cwd))}\n{"type":"mess\n${JSON.stringify(msg('a', null))}\n`,
      }),
      /not JSON/,
    ],
    [
      'a cut-off last line',
      (cwd) => ({
        raw: `${JSON.stringify(header(cwd))}\n${JSON.stringify(msg('a', null))}\n{"type":"message","id":"b"`,
      }),
      /cut-off line/,
    ],
    ['an empty file', () => ({ raw: '' }), /is empty/],
    [
      'another directory',
      () => ({ lines: [header('/usr'), msg('a', null)] }),
      /was started in "\/usr"/,
    ],
    [
      'another conversation id',
      (cwd) => ({ lines: [{ ...header(cwd), id: 'other' }, msg('a', null)] }),
      /belongs to conversation "other"/,
    ],
    [
      'an older format',
      (cwd) => ({ lines: [header(cwd, { version: 2 }), msg('a', null)] }),
      /format version 2/,
    ],
    [
      'a parent not in the file',
      (cwd) => ({ lines: [header(cwd), msg('a', null), msg('b', 'gone')] }),
      /parent is not in the file/,
    ],
    [
      'a duplicate entry id',
      (cwd) => ({ lines: [header(cwd), msg('a', null), msg('a', null)] }),
      /entry a twice/,
    ],
    ['a loop', (cwd) => ({ lines: [header(cwd), msg('a', 'b'), msg('b', 'a')] }), /loops at entry/],
    [
      'a compaction keeping a missing entry',
      (cwd) => ({
        lines: [
          header(cwd),
          msg('a', null),
          { type: 'compaction', id: 'c', parentId: 'a', firstKeptEntryId: 'zz' },
        ],
      }),
      /compaction c keeping/,
    ],
    [
      'a context edit of a missing entry',
      (cwd) => ({
        lines: [
          header(cwd),
          msg('a', null),
          { type: 'context_edit', id: 'e', parentId: 'a', targetId: 'zz' },
        ],
      }),
      /context edit e of an entry/,
    ],
    ['no header', () => ({ lines: [msg('a', null)] }), /session header/],
  ];

  it.each(cases)(
    'refuses %s with ProviderConversationUnavailableError, before Pi starts',
    async (name, make, reason) => {
      const made = adapter();
      const given = make(join(home, 'project'));
      writeTranscript(ID, join(home, 'project'), given.lines, given.raw);
      const error = await made
        .startSession(input({ resume: { nativeSessionId: ID } }))
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderConversationUnavailableError);
      expect(String(error)).toMatch(reason);
      // SC26: a cut-off last line names the exact command of the recovery procedure; anything
      // else says the procedure does not recover it.
      if (name === 'a cut-off last line') {
        const script = join(stateDir(), 'pi-recover.mjs');
        expect(String(error)).toContain(`node '${script}' '${sessionDir()}' '${ID}'`);
        expect(readFileSync(script, 'utf8')).toMatch(/^\/\/ Generated by Switch/);
      } else {
        expect(String(error)).toMatch(/recovers only a transcript whose last line is cut off/);
        expect(existsSync(join(stateDir(), 'pi-recover.mjs'))).toBe(false);
      }
      expect(spawned).toHaveLength(0);
      expect(heldLocks()).toEqual([]);
    }
  );

  it('refuses a transcript that is a link, a missing one, and two of the same conversation', async () => {
    const made = adapter();
    await expect(
      made.startSession(input({ resume: { nativeSessionId: ID } }))
    ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    const real = writeTranscript(ID, join(home, 'project'));
    const moved = join(home, 'elsewhere.jsonl');
    writeFileSync(moved, readFileSync(real));
    rmSync(real);
    symlinkSync(moved, real);
    await expect(made.startSession(input({ resume: { nativeSessionId: ID } }))).rejects.toThrow(
      /symbolic link/
    );
    rmSync(real);
    writeTranscript(ID, join(home, 'project'));
    writeFileSync(
      join(sessionDir(), `2026-11-04T10-00-00-000Z_${ID}.jsonl`),
      readFileSync(join(sessionDir(), `2026-11-03T10-00-00-000Z_${ID}.jsonl`))
    );
    await expect(made.startSession(input({ resume: { nativeSessionId: ID } }))).rejects.toThrow(
      /holds 2 transcripts/
    );
    await expect(
      made.startSession(input({ resume: { nativeSessionId: '../x' } }))
    ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(spawned).toHaveLength(0);
  });

  it('holds a conversation for one session at a time, and takes over a lock its owner left', async () => {
    writeTranscript(ID, join(home, 'project'));
    const first = adapter();
    const one = input({ resume: { nativeSessionId: ID } });
    await first.startSession(one);
    const second = adapter();
    const error = await second
      .startSession(input({ resume: { nativeSessionId: ID } }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(error).not.toBeInstanceOf(ProviderConversationUnavailableError);
    expect(String(error)).toMatch(/open in another Switch session/);
    expect(spawned).toHaveLength(1);
    await first.stopSession(one.sessionId);
    await second.startSession(input({ resume: { nativeSessionId: ID } }));
    expect(spawned).toHaveLength(2);
    await second.stopAll();
    // A lock whose owner died (a pid with another start time) is taken over.
    const lock = join(sessionDir(), `${ID}.lock`);
    rmSync(lock, { recursive: true, force: true });
    mkdirSync(lock);
    writeFileSync(
      join(lock, '7.owner'),
      JSON.stringify({ v: 1, pid: process.pid, start: 'not-this-start' })
    );
    await adapter().startSession(input({ resume: { nativeSessionId: ID } }));
    expect(spawned).toHaveLength(3);
    expect(readdirSync(lock)).toEqual(['8.owner']);
  });

  it('refuses a conversation another live process holds, and takes it once that process is gone', async () => {
    writeTranscript(ID, join(home, 'project'));
    const holder = startGroup('sleep 60', 'm-holder');
    const lock = join(sessionDir(), `${ID}.lock`);
    mkdirSync(lock);
    writeFileSync(
      join(lock, '1.owner'),
      JSON.stringify({ v: 1, pid: holder.pid, start: holder.starttime })
    );
    const made = adapter();
    const error = await made
      .startSession(input({ resume: { nativeSessionId: ID } }))
      .catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/open in another Switch session/);
    expect(spawned).toHaveLength(0);
    process.kill(-holder.pid, 'SIGKILL');
    await until(() => liveMembers(holder.pid) === 0, 'holder gone');
    await made.startSession(input({ resume: { nativeSessionId: ID } }));
    expect(spawned).toHaveLength(1);
  });

  it('cleans up after a host that died: its launch directories are swept before a start', async () => {
    const made = adapter();
    const run = join(stateDir(), 'run', 'dead-host-run');
    mkdirSync(run, { recursive: true });
    const orphan = startGroup('sleep 60', 'm-dead');
    register(join(run, 'processes.jsonl'), orphan, { toolCallId: 'c', run: 1, marker: 'm-dead' });
    writeFileSync(
      join(run, 'owner.json'),
      // A host that is gone: this pid with a start time it does not have, later than its own
      // (as a real one is: earlier than what it started, R3-A).
      JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart(), piSessionId: 'x' })
    );
    await made.startSession(input());
    expect(liveMembers(orphan.pid)).toBe(0);
    expect(existsSync(run)).toBe(false);
  });

  it('validates a good transcript and its typed references', async () => {
    const cwd = join(home, 'project');
    const file = writeTranscript(ID, cwd, [
      { type: 'session', version: 3, id: ID, timestamp: 't', cwd },
      msg('a', null),
      msg('b', 'a'),
      { type: 'compaction', id: 'c', parentId: 'b', firstKeptEntryId: 'b' },
      { type: 'context_edit', id: 'e', parentId: 'c', targetId: 'a' },
    ]);
    expect(await validatePiSessionFile(file, { id: ID, cwd: [cwd] })).toEqual({ ok: true });
    chmodSync(file, 0o000);
    if (process.getuid?.() !== 0)
      expect(await validatePiSessionFile(file, { id: ID, cwd: [cwd] })).toMatchObject({
        ok: false,
      });
    chmodSync(file, 0o600);
  });

  it('R1-D: of several adapters taking over a lock its holder left, one opens the conversation', async () => {
    writeTranscript(ID, join(home, 'project'));
    const lock = join(sessionDir(), `${ID}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(join(lock, '1.owner'), JSON.stringify({ v: 1, pid: process.pid, start: 'gone' }));
    const results = await Promise.allSettled(
      [adapter(), adapter(), adapter(), adapter()].map((made) =>
        made.startSession(input({ resume: { nativeSessionId: ID } }))
      )
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'rejected')
        expect(String(result.reason)).toMatch(/open in another Switch session/);
    expect(spawned).toHaveLength(1);
  });

  it('SC26: resumes the transcript a recovery mapped, never the original', async () => {
    const cwd = join(home, 'project');
    const original = writeTranscript(ID, cwd, undefined, undefined);
    writeFileSync(original, `${readFileSync(original, 'utf8')}{"type":"mess`);
    const recovered = join(sessionDir(), `2026-11-04T10-00-00-000Z_${ID}.jsonl`);
    writeFileSync(recovered, readFileSync(original, 'utf8').replace(/\{"type":"mess$/, ''));
    writeFileSync(
      join(sessionDir(), `${ID}.map.json`),
      JSON.stringify({ v: 1, file: `2026-11-04T10-00-00-000Z_${ID}.jsonl` })
    );
    const first = adapter();
    await first.startSession(input({ resume: { nativeSessionId: ID } }));
    expect(argAfter(last().args, '--session')).toBe(recovered);
    // A record Switch did not write is refused, as is one naming a file that is not there.
    await first.stopAll();
    for (const record of [
      { v: 1, file: '../elsewhere.jsonl' },
      { v: 1, file: `2026-11-05T10-00-00-000Z_${ID}.jsonl` },
    ]) {
      writeFileSync(join(sessionDir(), `${ID}.map.json`), JSON.stringify(record));
      const made = adapter();
      await expect(
        made.startSession(input({ resume: { nativeSessionId: ID } }))
      ).rejects.toBeInstanceOf(ProviderConversationUnavailableError);
    }
    expect(spawned).toHaveLength(1);
  });
});

describe('the Pi adapter: round 1 of stage 5 fixes (R1-A … R1-I)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const warnings = () =>
    of('runtime.warning')
      .map((event) => event.message)
      .join('\n');

  it('R1-A: the session stays busy while an interrupt is cleaned up; a message sent meanwhile waits and no prompt goes before the result', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const stubborn = startGroup('env -i /bin/sleep 60 & sleep 0.3', 'm-a');
    register(registry, stubborn, { toolCallId: 'now', run: 1, marker: 'm-a' });
    await pause(400);
    await made.interruptTurn(given.sessionId);
    settle(entry.pi, true);
    await until(() => completed('t').length === 1, 'interrupted turn');
    // The cleanup is under way (it gives up after 600 ms): the message waits for its result.
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' });
    await pause(100);
    expect(prompts(entry.pi)).toHaveLength(1);
    expect(of('turn.started').map((event) => event.turnId)).toEqual(['t']);
    await until(() => completed('next').length === 1, 'next turn', 4000);
    expect(completed('next')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/could not confirm/),
    });
    expect(prompts(entry.pi)).toHaveLength(1);
    const order = events
      .map((event) =>
        event.type === 'runtime.warning'
          ? 'warning'
          : event.type === 'turn.started' && event.turnId === 'next'
            ? 'next'
            : null
      )
      .filter(Boolean);
    expect(order.indexOf('warning')).toBeLessThan(order.indexOf('next'));
  });

  it('R1-A: a turn queued behind an interrupt that did not settle starts no new Pi while the cleanup is unconfirmed', async () => {
    const made = adapter({ interruptTimeoutMs: 50 });
    const { given, entry } = await started(made);
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const stubborn = startGroup('env -i /bin/sleep 60 & sleep 0.3', 'm-q');
    register(registry, stubborn, { toolCallId: 'now', run: 1, marker: 'm-q' });
    await pause(400);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'queued', text: 'y' });
    await made.interruptTurn(given.sessionId);
    await until(() => completed('queued').length === 1, 'queued turn', 4000);
    expect(completed('t')[0]?.outcome).toBe('interrupted');
    expect(completed('queued')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/could not confirm/),
    });
    expect(spawned).toHaveLength(1);
    process.kill(-stubborn.pid, 'SIGKILL');
    await until(() => liveMembers(stubborn.pid) === 0, 'manual kill');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'after', text: 'z' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
  });

  it('R1-B: a Pi that did not exit after an interrupt (dispose rejected) may live: no new Pi until its exit is confirmed', async () => {
    const made = adapter({ interruptTimeoutMs: 50 });
    const { given, entry } = await started(made);
    const stuck = startStuckPi(entry.options.env!.SWITCH_PI_BRIDGE as string);
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
      new Error('Provider process did not exit after termination.')
    );
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    await made.interruptTurn(given.sessionId);
    await until(() => /could not confirm that it exited/.test(warnings()), 'warning', 4000);
    expect(completed('t')[0]?.outcome).toBe('interrupted');
    await expect(
      made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' })
    ).rejects.toThrow(/could not confirm that it exited/);
    expect(spawned).toHaveLength(1);
    expect(existsSync(dirname(entry.config!.processRegistry))).toBe(true);
    // Gone (procfs shows no process of that launch): its exit is confirmed, a new Pi runs.
    process.kill(stuck.pid, 'SIGKILL');
    await until(() => liveMembers(stuck.pid) === 0, 'stuck Pi gone');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
  });

  it('R1-B, R1-E: a stop whose Pi did not exit keeps the launch, records it beside the conversation, and the next start (another adapter) ends that Pi first', async () => {
    const first = adapter();
    const { given, entry, session } = await started(first);
    const registry = entry.config!.processRegistry;
    const bridgeConfig = entry.options.env!.SWITCH_PI_BRIDGE as string;
    const stuck = startStuckPi(bridgeConfig);
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
      new Error('Provider process did not exit after termination.')
    );
    await first.stopSession(given.sessionId);
    vi.restoreAllMocks();
    expect(warnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    expect(existsSync(dirname(registry))).toBe(true);
    const record = join(sessionDir(), `${session.nativeSessionId}.cleanup.json`);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      v: 1,
      // R5-B: with the identity of the host that made the launch (its owner.json).
      launches: [
        {
          runDir: dirname(registry),
          registry,
          bridgeConfig,
          owner: { pid: process.pid, start: hostStart() },
        },
      ],
    });
    // The lock goes only after the record is written.
    expect(heldLocks()).toEqual([]);
    writeTranscript(session.nativeSessionId, given.cwd);
    let stuckAtSpawn = -1;
    configure = () => {
      stuckAtSpawn = liveMembers(stuck.pid);
    };
    await adapter().startSession(input({ resume: { nativeSessionId: session.nativeSessionId } }));
    expect(stuckAtSpawn).toBe(0);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(dirname(registry))).toBe(false);
  });

  it('R1-E: another adapter refuses a conversation whose stop could not confirm its cleanup, until it can', async () => {
    const first = adapter();
    const { given, entry, session } = await started(first);
    const registry = entry.config!.processRegistry;
    const stubborn = startGroup('env -i /bin/sleep 60 & sleep 0.3', 'm-e');
    register(registry, stubborn, { toolCallId: 'c', run: 1, marker: 'm-e' });
    await pause(400);
    await first.stopSession(given.sessionId);
    const record = join(sessionDir(), `${session.nativeSessionId}.cleanup.json`);
    expect(existsSync(record)).toBe(true);
    writeTranscript(session.nativeSessionId, given.cwd);
    const resume = input({ resume: { nativeSessionId: session.nativeSessionId } });
    // A new adapter in this host (the host is alive: no dead-host sweep applies).
    await expect(adapter().startSession(resume)).rejects.toThrow(/could not confirm/);
    expect(spawned).toHaveLength(1);
    process.kill(-stubborn.pid, 'SIGKILL');
    await until(() => liveMembers(stubborn.pid) === 0, 'manual kill');
    await adapter().startSession({ ...resume, sessionId: `${resume.sessionId}-2` });
    expect(spawned).toHaveLength(2);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(dirname(registry))).toBe(false);
  });

  it('R1-B: a record of unconfirmed cleanup Switch cannot read refuses the start', async () => {
    const ID = '0199a5c0-0000-7000-8000-0000000000b1';
    writeTranscript(ID, join(home, 'project'));
    writeFileSync(join(sessionDir(), `${ID}.cleanup.json`), '{"v":1,"launches":[{"runDir":1}]}');
    await expect(
      adapter().startSession(input({ resume: { nativeSessionId: ID } }))
    ).rejects.toThrow(/cannot tell whether the processes/);
    expect(spawned).toHaveLength(0);
  });

  it('R1-C: an interrupt also kills a shell of its run recorded only as intended, and leaves one of an earlier run', async () => {
    const { made, given, entry } = await started();
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'first', text: 'a' });
    await until(() => prompts(entry.pi).length === 1, 'first prompt');
    entry.pi.emitRecords(fakePiTextTurn('a', 'one'));
    await until(() => completed('first').length === 1, 'first turn');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'second', text: 'b' });
    await until(() => prompts(entry.pi).length === 2, 'second prompt');
    const earlier = startGroup('sleep 60', 'i-1:old');
    const current = startGroup('sleep 60', 'i-1:now');
    const intent = (toolCallId: string, run: number, marker: string) =>
      `${JSON.stringify({ v: 1, instance: 'i-1', toolCallId, run, marker: tagged(marker), event: 'intent' })}\n`;
    writeFileSync(registry, intent('old', 1, 'i-1:old') + intent('now', 2, 'i-1:now'), {
      flag: 'a',
    });
    await made.interruptTurn(given.sessionId);
    settle(entry.pi, true);
    await until(() => completed('second').length === 1, 'second turn');
    await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
    expect(liveMembers(current.pid)).toBe(0);
    expect(liveMembers(earlier.pid)).toBeGreaterThan(0);
    // R2-D: the earlier shell, recorded only as intended, is reported and is background work.
    expect(warnings()).toMatch(/1 command\(s\) started earlier .* still run/);
    expect(made.hasBackgroundWork(given.sessionId)).toBe(true);
  });

  it('R1-F: a stop while the session starts ends the start: nothing ready, no Pi, no launch left', async () => {
    writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\nsleep 0.4\necho 1.4.0\n', { mode: 0o755 });
    for (const overrides of [{}, { model: undefined, mcpServers: {} }]) {
      events.length = 0;
      const made = adapter();
      const given = input(overrides);
      const starting = made.startSession(given).catch((caught: unknown) => caught);
      await pause(100);
      await made.stopSession(given.sessionId);
      const error = await starting;
      expect(error).toBeInstanceOf(ProviderSessionError);
      expect(String(error)).toMatch(/stopped while it started/);
      expect(spawned).toHaveLength(0);
      expect(of('session.started')).toHaveLength(0);
      expect(of('session.state.changed').map((event) => event.status)).toEqual([
        'starting',
        'stopped',
      ]);
      expect(of('session.exited')).toHaveLength(1);
      expect(made.hasSession(given.sessionId)).toBe(false);
      const runs = join(stateDir(), 'run');
      expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
      expect(heldLocks()).toEqual([]);
    }
  });

  it('R1-G: Switch’s context is kept when the first message fails before Pi takes it', async () => {
    const { made, given, entry } = await started(adapter(), { systemContext: 'CONTEXT' });
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'a',
      text: 'hi',
      attachments: [{ path: join(home, 'missing.png'), mimeType: 'image/png' }],
    });
    await until(() => completed('a').length === 1, 'a');
    expect(completed('a')[0]?.outcome).toBe('error');
    expect(prompts(entry.pi)).toHaveLength(0);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'b', text: 'again' });
    await until(() => prompts(entry.pi).length === 1, 'b');
    expect(prompts(entry.pi)[0]?.message).toBe('CONTEXT\n\nagain');
    entry.pi.emitRecords(fakePiTextTurn('again', 'x'));
    await until(() => completed('b').length === 1, 'b done');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'c', text: 'more' });
    await until(() => prompts(entry.pi).length === 2, 'c');
    expect(prompts(entry.pi)[1]?.message).toBe('more');
  });

  it('R1-H: a prompt Pi does not answer in time stops that Pi; the next turn runs in a new one', async () => {
    const made = adapter({ promptTimeoutMs: 150 });
    const { given, entry } = await started(made);
    entry.pi.handlers.set('prompt', () => undefined);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'x' });
    await until(() => completed('t1').length === 1, 't1');
    expect(completed('t1')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/what it did with it is unknown/),
    });
    await until(() => entry.pi.signals.includes('SIGTERM'), 'old Pi stopped');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'y' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    expect(prompts(entry.pi)).toHaveLength(1);
    expect(argAfter(last().args, '--session-id')).toBe(argAfter(entry.args, '--session-id'));
  });

  describe('R1-I: without procfs, processes are read with ps', () => {
    const noProc = () => join(home, 'no-proc');

    it('confirms an empty registry, and an adapter without procfs runs on after an interrupt', async () => {
      const registry = join(home, 'empty.jsonl');
      writeFileSync(registry, '');
      expect(
        await killPiBashGroups(registry, () => true, { includeUnspawned: true, procRoot: noProc() })
      ).toEqual({ confirmed: true, killed: 0, unconfirmed: [] });
      const made = adapter({ procRoot: noProc() });
      const { given, entry } = await started(made);
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
      await until(() => prompts(entry.pi).length === 1, 'prompt');
      await made.interruptTurn(given.sessionId);
      settle(entry.pi, true);
      await until(() => completed('t').length === 1, 'turn');
      await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
      await made.sendTurn({ sessionId: given.sessionId, turnId: 'next', text: 'y' });
      await until(() => prompts(entry.pi).length === 2, 'next prompt');
      await made.stopSession(given.sessionId);
      expect(existsSync(dirname(entry.config!.processRegistry))).toBe(false);
    });

    it('counts a live group through ps, and stays unconfirmed when ps cannot run', async () => {
      const registry = join(home, 'reg.jsonl');
      const group = startGroup('sleep 60', 'm-ps');
      register(registry, group, { toolCallId: 'c', run: 1, marker: 'm-ps' });
      const seen = await killPiBashGroups(registry, () => true, {
        procRoot: noProc(),
        timeoutMs: 200,
      });
      // Not verifiable without procfs (`pi-bash.ts`), so not signalled; ps sees it live.
      expect(seen.confirmed).toBe(false);
      // The count ps gave is the one procfs shows.
      const counted = /c: (\d+) process\(es\) left/.exec(seen.unconfirmed.join('; '))?.[1];
      expect(Number(counted)).toBe(liveMembers(group.pid));
      expect(liveMembers(group.pid)).toBeGreaterThan(0);
      const noPs = await killPiBashGroups(registry, () => true, {
        procRoot: noProc(),
        ps: join(home, 'no-ps'),
        timeoutMs: 200,
      });
      expect(noPs.unconfirmed.join('; ')).toMatch(/process table could not be read/);
      // With procfs (the fast path) the same group is verified and killed.
      expect(
        (await killPiBashGroups(registry, () => true, { timeoutMs: 600, since: hostStart() }))
          .confirmed
      ).toBe(true);
      expect(liveMembers(group.pid)).toBe(0);
    });

    it('never takes a group for gone when its markers cannot be read', async () => {
      const registry = join(home, 'reg.jsonl');
      const group = startGroup('sleep 60', 'm-gone');
      register(registry, group, { toolCallId: 'c', run: 1, marker: 'm-gone' });
      process.kill(-group.pid, 'SIGKILL');
      await until(() => liveMembers(group.pid) === 0, 'gone');
      const result = await killPiBashGroups(registry, () => true, {
        procRoot: noProc(),
        timeoutMs: 200,
      });
      expect(result.confirmed).toBe(false);
      expect(result.unconfirmed.join('; ')).toMatch(/markers of the commands could not be read/);
    });
  });
});

describe('the Pi adapter: round 2 of stage 5 fixes (R2-A … R2-E)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const warnings = () =>
    of('runtime.warning')
      .map((event) => event.message)
      .join('\n');
  /** A Pi that takes signals and does not die of them: it exits only when the test says so. */
  function survivesSignals(pi: FakePi): void {
    pi.kill = (signal?: NodeJS.Signals) => {
      pi.signals.push(signal ?? 'SIGTERM');
      return true;
    };
  }

  it('R2-A: a failed output stream of a Pi that still runs is not its exit: nothing is let go until it exits', async () => {
    const { made, given, entry } = await started();
    const runDir = dirname(entry.config!.processRegistry);
    survivesSignals(entry.pi);
    entry.pi.stdout.emit('error', new Error('read EIO'));
    // The link is gone; Switch stops the Pi and waits for its exit.
    await until(() => entry.pi.signals.includes('SIGTERM'), 'Pi asked to stop');
    await pause(300);
    expect(of('session.exited')).toHaveLength(0);
    expect(existsSync(runDir)).toBe(true);
    expect(heldLocks()).toHaveLength(1);
    expect(made.hasSession(given.sessionId)).toBe(true);
    entry.pi.exit(null, 'SIGKILL', { endOutput: false });
    await until(() => of('session.exited').length === 1, 'session ended');
    expect(of('session.exited')[0]?.reason).toMatch(/read EIO/);
    expect(existsSync(runDir)).toBe(false);
    expect(heldLocks()).toEqual([]);
    expect(warnings()).not.toMatch(/could not confirm/);
  });

  it('R2-A: a failed stream and a Pi that never exits (dispose rejected): the launch is kept and recorded, the conversation refused until that Pi is gone', async () => {
    const { given, entry, session } = await started();
    const registry = entry.config!.processRegistry;
    const bridgeConfig = entry.options.env!.SWITCH_PI_BRIDGE as string;
    const stuck = startStuckPi(bridgeConfig);
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
      new Error('Provider process did not exit after termination.')
    );
    entry.pi.stderr.emit('error', new Error('read EIO'));
    await until(() => of('session.exited').length === 1, 'session ended');
    vi.restoreAllMocks();
    expect(warnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    expect(existsSync(dirname(registry))).toBe(true);
    const record = join(sessionDir(), `${session.nativeSessionId}.cleanup.json`);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      v: 1,
      // R5-B: with the identity of the host that made the launch (its owner.json).
      launches: [
        {
          runDir: dirname(registry),
          registry,
          bridgeConfig,
          owner: { pid: process.pid, start: hostStart() },
        },
      ],
    });
    writeTranscript(session.nativeSessionId, given.cwd);
    // The start that follows ends that Pi first.
    let stuckAtSpawn = -1;
    configure = () => {
      stuckAtSpawn = liveMembers(stuck.pid);
    };
    await adapter().startSession(input({ resume: { nativeSessionId: session.nativeSessionId } }));
    expect(stuckAtSpawn).toBe(0);
    expect(existsSync(record)).toBe(false);
  });

  it('R2-C: a set_model Pi does not answer in time stops that Pi, even when it switches late; the next turn runs in a new Pi on the session’s model', async () => {
    const made = adapter({ startTimeoutMs: 200 });
    const { given, entry } = await started(made);
    entry.pi.handlers.set('set_model', () => undefined);
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'a',
      text: 'x',
      model: { id: 'fake/other-model' },
    });
    await until(() => completed('a').length === 1, 'a');
    expect(completed('a')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/which model it runs is unknown/),
    });
    // Pi carries out the switch late.
    const late = entry.pi.received.find((command) => command.type === 'set_model');
    entry.pi.respond(late?.id, 'set_model', { data: { ...FAKE_PI_MODEL, id: 'other-model' } });
    await until(() => entry.pi.signals.includes('SIGTERM'), 'old Pi stopped');
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'b',
      text: 'y',
      model: { id: MODEL },
    });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    expect(prompts(entry.pi)).toHaveLength(0);
    expect(argAfter(last().args, '--model')).toBe(MODEL);
    expect(last().pi.received.some((command) => command.type === 'set_model')).toBe(false);
  });

  it('R2-C: outside a turn too, an unconfirmed set_model stops that Pi; a message sent meanwhile waits and runs in a new Pi', async () => {
    const made = adapter({ startTimeoutMs: 200 });
    const { given, entry } = await started(made);
    entry.pi.handlers.set('set_model', () => undefined);
    const switching = made
      .setModel(given.sessionId, { id: 'fake/other-model' })
      .catch((caught: unknown) => caught);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'm', text: 'y' });
    const error = await switching;
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(/which model it runs is unknown/);
    expect(entry.pi.signals).toContain('SIGTERM');
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    expect(prompts(entry.pi)).toHaveLength(0);
  });

  it('R2-D: background work is surveyed over every generation of the session', async () => {
    const made = adapter({ interruptTimeoutMs: 50 });
    const { given, entry } = await started(made);
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'a' });
    await until(() => prompts(entry.pi).length === 1, 't1 prompt');
    const background = startGroup('sleep 60', 'm-bg');
    register(registry, background, { toolCallId: 'bg', run: 1, marker: 'm-bg' });
    entry.pi.emitRecords(fakePiTextTurn('a', 'one'));
    await until(() => completed('t1').length === 1, 't1');
    // An interrupt that does not settle stops this Pi; the earlier command is left (Q1 A).
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'b' });
    await until(() => prompts(entry.pi).length === 2, 't2 prompt');
    await made.interruptTurn(given.sessionId);
    await until(() => completed('t2').length === 1, 't2');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't3', text: 'c' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    last().pi.emitRecords(fakePiTextTurn('c', 'three'));
    await until(() => completed('t3').length === 1, 't3');
    await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
    expect(liveMembers(background.pid)).toBeGreaterThan(0);
    expect(made.hasBackgroundWork(given.sessionId)).toBe(true);
    await made.stopSession(given.sessionId);
    expect(liveMembers(background.pid)).toBe(0);
  });

  it('R2-D: a command whose state cannot be seen is reported unknown and counts as background work', async () => {
    const made = adapter({ procRoot: join(home, 'no-proc') });
    const { given, entry } = await started(made);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    writeFileSync(
      entry.config!.processRegistry,
      `${JSON.stringify({ v: 1, instance: 'i-1', toolCallId: 'old', run: 0, marker: 'i-1:old', event: 'intent' })}\n`,
      { flag: 'a' }
    );
    await made.interruptTurn(given.sessionId);
    settle(entry.pi, true);
    await until(() => completed('t').length === 1, 'turn');
    await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
    expect(warnings()).toMatch(/state of 1 command\(s\) started earlier .* is unknown/);
    expect(made.hasBackgroundWork(given.sessionId)).toBe(true);
  });

  /**
   * A session whose interrupt cleanup is blocked by a registry Switch cannot read (unconfirmed),
   * and that registry readable again: the next check of the block passes. `queued` is sent
   * behind the interrupted turn, so it starts (and checks the block) as that turn ends.
   */
  async function blockedByUnreadableRegistry(queued?: string) {
    const ctx = await started();
    const registry = ctx.entry.config!.processRegistry;
    writeFileSync(registry, '');
    await ctx.made.sendTurn({ sessionId: ctx.given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(ctx.entry.pi).length === 1, 'prompt');
    if (queued)
      await ctx.made.sendTurn({ sessionId: ctx.given.sessionId, turnId: queued, text: 'y' });
    chmodSync(registry, 0o000);
    await ctx.made.interruptTurn(ctx.given.sessionId);
    return { ...ctx, readable: () => chmodSync(registry, 0o600) };
  }

  it('R2-E: a message sent while a blocked cleanup is checked again is refused when the session is stopped meanwhile, never left queued', async () => {
    if (process.getuid?.() === 0) return;
    const { made, given, entry, readable } = await blockedByUnreadableRegistry();
    settle(entry.pi, true);
    await until(() => of('session.state.changed').at(-1)?.status === 'error', 'blocked');
    expect(warnings()).toMatch(/registry: EACCES/);
    readable();
    // The check passes now; the stop comes while `sendTurn` waits for it.
    const sending = made
      .sendTurn({ sessionId: given.sessionId, turnId: 'late', text: 'y' })
      .then(() => null)
      .catch((caught: unknown) => caught);
    const stopping = made.stopSession(given.sessionId);
    const error = await sending;
    await stopping;
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(/stopped while Switch checked its cleanup/);
    expect(of('turn.started').map((event) => event.turnId)).toEqual(['t']);
    expect(completed('late')).toHaveLength(0);
    expect(prompts(entry.pi)).toHaveLength(1);
  });

  it('R2-E: a turn waiting on that check ends with the stop, and no Pi is prepared for it afterwards', async () => {
    if (process.getuid?.() === 0) return;
    const calls = join(home, 'pi-calls');
    writeFileSync(join(home, 'bin', 'pi'), `#!/bin/sh\necho x >> '${calls}'\necho 1.4.0\n`, {
      mode: 0o755,
    });
    const { made, given, entry, readable } = await blockedByUnreadableRegistry('next');
    const before = readFileSync(calls, 'utf8');
    // As the queued turn starts (its block check is next), the block clears and the session stops.
    let stopping: Promise<void> | null = null;
    made.subscribe((event) => {
      if (event.type === 'turn.started' && event.turnId === 'next' && !stopping) {
        readable();
        stopping = made.stopSession(given.sessionId);
      }
    });
    settle(entry.pi, true);
    await until(() => stopping !== null, 'next started');
    await stopping;
    await pause(300);
    // Ended by the stop (`stopSession` ends the running turn interrupted), not left running.
    expect(completed('next')).toHaveLength(1);
    expect(completed('next')[0]?.outcome).toBe('interrupted');
    expect(readFileSync(calls, 'utf8')).toBe(before);
    expect(spawned).toHaveLength(1);
  });
});

describe('the Pi adapter: round 3 of stage 5 fixes (R3-A … R3-D)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const warnings = () =>
    of('runtime.warning')
      .map((event) => event.message)
      .join('\n');
  const ownUid = process.getuid?.() ?? 0;

  /**
   * A stop whose Pi did not exit when stopped (`dispose` rejected), while a live process of this
   * user carries its launch's `SWITCH_PI_BRIDGE` and procfs answers `fault.code` for its `fault.file`.
   */
  async function stopWithUnseenPi(
    fault: { file: 'environ' | 'stat'; code: string },
    options: ConstructorParameters<typeof PiAdapter>[0] = {}
  ) {
    const made = adapter(options);
    const { given, entry, session } = await started(made);
    const runDir = dirname(entry.config!.processRegistry);
    const stuck = startStuckPi(entry.options.env!.SWITCH_PI_BRIDGE as string);
    await until(() => readPiProcStat(stuck.pid)?.state === 'S', 'stand-in Pi');
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
      new Error('Provider process did not exit after termination.')
    );
    fsFaults.read = (file) => (file === `/proc/${stuck.pid}/${fault.file}` ? fault.code : null);
    await made.stopSession(given.sessionId);
    fsFaults.read = null;
    vi.restoreAllMocks();
    const record = join(sessionDir(), `${session.nativeSessionId}.cleanup.json`);
    return { runDir, record, stuck };
  }

  it('R3-A: a Pi whose environment this user cannot read (EACCES) is not taken for gone: the launch is kept and recorded', async () => {
    const { runDir, record, stuck } = await stopWithUnseenPi({ file: 'environ', code: 'EACCES' });
    expect(readPiProcStat(stuck.pid)?.state).toBe('S');
    expect(warnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(record)).toBe(true);
  });

  it('R3-A: a Pi whose stat cannot be read (EIO) after its environment named the launch is not taken for gone', async () => {
    const { runDir, record } = await stopWithUnseenPi({ file: 'stat', code: 'EIO' });
    expect(warnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    expect(existsSync(runDir)).toBe(true);
    expect(existsSync(record)).toBe(true);
  });

  it('R3-A: a process procfs shows to be another user’s (EACCES) is left out: the stop is confirmed', async () => {
    const { runDir, record } = await stopWithUnseenPi(
      { file: 'environ', code: 'EACCES' },
      { uid: ownUid + 1 }
    );
    expect(warnings()).not.toMatch(/could not confirm|did not exit/);
    expect(existsSync(runDir)).toBe(false);
    expect(existsSync(record)).toBe(false);
  });

  it('R3-A: an unreadable process of this user started before the host that made the launch is left out, a later one is not', async () => {
    const registry = join(home, 'reg.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, instance: 'i', toolCallId: 'c', run: 1, marker: 'm-none', event: 'intent' })}\n`
    );
    // The parent of this process started before it (the host here): it cannot carry a variable
    // of a launch this host made.
    fsFaults.read = (file) => (file === `/proc/${process.ppid}/environ` ? 'EACCES' : null);
    const options = { includeUnspawned: true, timeoutMs: 200 } as const;
    expect(
      await killPiBashGroups(registry, () => true, { ...options, since: hostStart() })
    ).toEqual({ confirmed: true, killed: 0, unconfirmed: [] });
    // Without the host's start, nothing rules it out.
    const unknown = await killPiBashGroups(registry, () => true, { ...options, since: null });
    expect(unknown.confirmed).toBe(false);
    expect(unknown.unconfirmed.join('; ')).toMatch(/markers of the commands could not be read/);
    // A process started after the host (its own shell, say) stays unseen.
    const later = startGroup('sleep 60', 'm-later');
    fsFaults.read = (file) => (file === `/proc/${later.pid}/environ` ? 'EACCES' : null);
    const seen = await killPiBashGroups(registry, () => true, { ...options, since: hostStart() });
    expect(seen.confirmed).toBe(false);
  });

  it('R3-B: a set_model answered with an error after Pi switched stops that Pi; a turn on the earlier model runs in a new Pi, never on the wrong one', async () => {
    const made = adapter({ startTimeoutMs: 300 });
    const { given, entry } = await started(made);
    // Pi 1.4.0: the model changes, then writing the change into the transcript fails, and that is
    // the answer (`agent-session.js:2008-2016`, `rpc-mode.js:634-636`).
    entry.pi.handlers.set('set_model', (command) => {
      runningModels.set(entry.pi, { ...FAKE_PI_MODEL, id: String(command.modelId) });
      return { error: 'EIO: i/o error, write' };
    });
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'a',
      text: 'x',
      model: { id: 'fake/other-model' },
    });
    await until(() => completed('a').length === 1, 'a');
    expect(completed('a')[0]).toMatchObject({
      outcome: 'error',
      message: expect.stringMatching(/with an error \(EIO.*\) and runs fake\/other-model/),
    });
    await until(() => entry.pi.signals.includes('SIGTERM'), 'that Pi stopped');
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'b',
      text: 'y',
      model: { id: MODEL },
    });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    expect(prompts(entry.pi)).toHaveLength(0);
    expect(argAfter(last().args, '--model')).toBe(MODEL);
    // An error with a `get_state` that cannot be had is no proof of a refusal either.
    const second = last();
    second.pi.handlers.set('set_model', () => ({ error: 'Model not found: fake/other-model' }));
    second.pi.handlers.set('get_state', () => ({ error: 'busy' }));
    second.pi.emitRecords(fakePiTextTurn('y', 'ok'));
    await until(() => completed('b').length === 1, 'b');
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'c',
      text: 'z',
      model: { id: 'fake/other-model' },
    });
    await until(() => completed('c').length === 1, 'c');
    expect(completed('c')[0]?.message).toMatch(/cannot say which model it runs/);
    await until(() => second.pi.signals.includes('SIGTERM'), 'second Pi stopped');
    expect(prompts(second.pi)).toHaveLength(1);
  });

  it('R3-B: a refusal get_state proves (Pi still runs the session’s model) keeps the Pi', async () => {
    const { made, given, entry } = await started();
    await made.sendTurn({
      sessionId: given.sessionId,
      turnId: 'a',
      text: 'x',
      model: { id: 'fake/missing' },
    });
    await until(() => completed('a').length === 1, 'a');
    expect(completed('a')[0]?.message).toMatch(
      /could not switch to fake\/missing: Model not found/
    );
    await made.sendTurn({ sessionId: given.sessionId, turnId: 'b', text: 'y' });
    await until(() => prompts(entry.pi).length === 1, 'prompt in the same Pi');
    expect(spawned).toHaveLength(1);
    expect(entry.pi.signals).toEqual([]);
  });

  /** Holds every `dispose` (the cleanup of a stop) until `release`. */
  function holdCleanup() {
    const original = PiRpcClient.prototype.dispose;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockImplementation(
      async function (this: InstanceType<typeof PiRpcClient>) {
        await gate;
        return original.call(this);
      }
    );
    return release;
  }
  /** What a caller finds when its stop settles. */
  function whenDone(made: InstanceType<typeof PiAdapter>, id: string, runDir: string | null) {
    const seen: Array<Record<string, unknown>> = [];
    const note = (who: string) => () =>
      seen.push({
        who,
        exited: of('session.exited', id).length,
        runDir: runDir === null ? null : existsSync(runDir),
        session: made.hasSession(id),
      });
    return { seen, note };
  }

  it('R3-C: a second stop and stopAll during a stop wait for its cleanup and session.exited', async () => {
    const { made, given, entry } = await started();
    const runDir = dirname(entry.config!.processRegistry);
    const release = holdCleanup();
    const { seen, note } = whenDone(made, given.sessionId, runDir);
    const all = [
      made.stopSession(given.sessionId).then(note('first')),
      made.stopSession(given.sessionId).then(note('second')),
      made.stopAll().then(note('stopAll')),
    ];
    await pause(150);
    expect(seen).toEqual([]);
    release();
    await Promise.all(all);
    const done = { exited: 1, runDir: false, session: false };
    expect(seen).toEqual(
      expect.arrayContaining([
        { who: 'first', ...done },
        { who: 'second', ...done },
        { who: 'stopAll', ...done },
      ])
    );
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
  });

  it('R3-C: a stop and stopAll while Pi’s own end is cleaned up wait for it', async () => {
    const { made, given, entry } = await started();
    const runDir = dirname(entry.config!.processRegistry);
    const release = holdCleanup();
    entry.pi.exit(1, null);
    await pause(50);
    expect(of('session.exited', given.sessionId)).toHaveLength(0);
    const { seen, note } = whenDone(made, given.sessionId, runDir);
    const all = [
      made.stopSession(given.sessionId).then(note('stop')),
      made.stopAll().then(note('stopAll')),
    ];
    await pause(150);
    expect(seen).toEqual([]);
    release();
    await Promise.all(all);
    const done = { exited: 1, runDir: false, session: false };
    expect(seen).toEqual(
      expect.arrayContaining([
        { who: 'stop', ...done },
        { who: 'stopAll', ...done },
      ])
    );
    expect(of('session.exited', given.sessionId)[0]?.reason).toMatch(/Pi stopped unexpectedly/);
  });

  it('R3-C: every stop of a start that is stopped waits for the start to end', async () => {
    writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\nsleep 0.4\necho 1.4.0\n', { mode: 0o755 });
    const made = adapter();
    const given = input();
    const starting = made.startSession(given).catch((caught: unknown) => caught);
    await pause(100);
    const { seen, note } = whenDone(made, given.sessionId, null);
    const all = [
      made.stopSession(given.sessionId).then(note('first')),
      made.stopSession(given.sessionId).then(note('second')),
      made.stopAll().then(note('stopAll')),
    ];
    await Promise.all(all);
    expect(String(await starting)).toMatch(/stopped while it started/);
    const done = { exited: 1, runDir: null, session: false };
    expect(seen).toEqual(
      expect.arrayContaining([
        { who: 'first', ...done },
        { who: 'second', ...done },
        { who: 'stopAll', ...done },
      ])
    );
    const runs = join(stateDir(), 'run');
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
  });

  it('R3-D: a stop while owner.json is written removes the launch directory; the conversation can be recovered', async () => {
    let writing = false;
    let release!: () => void;
    const written = new Promise<void>((resolve) => {
      release = resolve;
    });
    fsFaults.write = async (file) => {
      if (!file.endsWith('owner.json')) return;
      writing = true;
      await written;
    };
    const made = adapter();
    const given = input();
    const starting = made.startSession(given).catch((caught: unknown) => caught);
    await until(() => writing, 'owner.json being written');
    const stopping = made.stopSession(given.sessionId);
    release();
    await stopping;
    expect(String(await starting)).toMatch(/stopped while it started/);
    expect(spawned).toHaveLength(0);
    const runs = join(stateDir(), 'run');
    expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    expect(heldLocks()).toEqual([]);
    // The conversation (its lock names it) is not held by a launch: its recovery goes ahead.
    const id = readdirSync(sessionDir())
      .find((name) => name.endsWith('.lock'))
      ?.slice(0, -'.lock'.length);
    expect(id).toBeDefined();
    const transcript = writeTranscript(id as string, given.cwd);
    writeFileSync(transcript, '{"type":"message","id":"cut', { flag: 'a' });
    expect(piConversationStore().recover(sessionDir(), id as string)).toMatchObject({
      status: 'preview',
    });
  });
});

describe('the Pi adapter: round 4 of stage 5 fixes (R4-A, R4-B)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const ID = '0199a5c0-0000-7000-8000-0000000004a1';
  const isGone = (pid: number) => {
    const stat = readPiProcStat(pid);
    return !stat || stat.state === 'Z';
  };
  /**
   * A procfs that shows this process and `pids` only (links to their entries in `/proc`), and,
   * with `unreadable`, one process whose environment cannot be read (`EISDIR`): what the adapter
   * sees of the process table is exactly that, whatever else runs on the machine.
   */
  function procOf(pids: number[], options: { unreadable?: boolean; self?: boolean } = {}) {
    const root = mkdtempSync(join(home, 'proc-'));
    for (const pid of options.self === false ? pids : [process.pid, ...pids])
      symlinkSync(`/proc/${pid}`, join(root, String(pid)));
    if (options.unreadable) mkdirSync(join(root, '999999', 'environ'), { recursive: true });
    return root;
  }
  /**
   * Conversation `ID` as a host that is gone left it: its transcript, the lock it held (taken
   * over by the next start: its holder is gone), and a launch directory with `owner` as its
   * `owner.json`.
   */
  function leftByDeadHost(owner: string): string {
    writeTranscript(ID, join(home, 'project'));
    const lock = join(sessionDir(), `${ID}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, '1.owner'),
      JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart() })
    );
    const run = join(stateDir(), 'run', 'left-run');
    mkdirSync(run, { recursive: true });
    writeFileSync(join(run, 'owner.json'), owner);
    return run;
  }
  const resume = () => input({ resume: { nativeSessionId: ID } });

  it('R4-A: a launch of a dead host whose owner has no start time blocks its conversation while its Pi lives; once it is gone, the start goes ahead', async () => {
    const run = leftByDeadHost(
      JSON.stringify({ v: 1, pid: process.pid, start: null, piSessionId: ID })
    );
    const stuck = startStuckPi(join(run, 'config.json'));
    await until(() => readPiProcStat(stuck.pid)?.state === 'S', 'stand-in Pi');
    const made = adapter({ procRoot: procOf([stuck.pid]) });
    const error = await made.startSession(resume()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(
      /owner whose start time is unknown, and the Pi of launch .*left-run still runs/
    );
    expect(spawned).toHaveLength(0);
    expect(heldLocks()).toEqual([]);
    // Its host cannot be told gone: nothing of the launch is killed or removed.
    expect(isGone(stuck.pid)).toBe(false);
    expect(existsSync(run)).toBe(true);
    process.kill(stuck.pid, 'SIGKILL');
    await until(() => isGone(stuck.pid), 'stand-in Pi gone');
    const session = await made.startSession(resume());
    expect(session.nativeSessionId).toBe(ID);
    expect(spawned).toHaveLength(1);
  });

  it('R4-A: such a launch also blocks while anything that may be it cannot be read', async () => {
    leftByDeadHost(JSON.stringify({ v: 1, pid: process.pid, start: null, piSessionId: ID }));
    const unseen = adapter({ procRoot: procOf([], { unreadable: true }) });
    const error = await unseen.startSession(resume()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(/whether the Pi of launch .*left-run runs cannot be seen/);
    expect(spawned).toHaveLength(0);
    // Every process seen, none of the launch: the start goes ahead.
    await adapter({ procRoot: procOf([]) }).startSession(resume());
    expect(spawned).toHaveLength(1);
  });

  it('R4-A: a launch whose owner.json is damaged or cannot be read blocks every conversation of the state directory while its Pi lives', async () => {
    const run = leftByDeadHost('{"v":1,"pid":');
    const stuck = startStuckPi(join(run, 'config.json'));
    await until(() => readPiProcStat(stuck.pid)?.state === 'S', 'stand-in Pi');
    const made = adapter({ procRoot: procOf([stuck.pid]) });
    const refusal = async (start: ProviderSessionStartInput) => {
      const error = await made.startSession(start).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ProviderSessionError);
      return String(error);
    };
    // Its own conversation, and a new one: either may be the one that Pi writes.
    expect(await refusal(resume())).toMatch(
      /cannot tell which Pi conversation .*owner \(owner\.json\) is damaged or not one Switch wrote, and the Pi of launch .* still runs/
    );
    expect(await refusal(input())).toMatch(/starts no Pi for any conversation of /);
    writeFileSync(join(run, 'owner.json'), JSON.stringify({ v: 1, pid: process.pid }));
    expect(await refusal(input())).toMatch(/is damaged or not one Switch wrote/);
    writeFileSync(
      join(run, 'owner.json'),
      JSON.stringify({ v: 1, pid: process.pid, piSessionId: ID, start: null })
    );
    chmodSync(join(run, 'owner.json'), 0o000);
    expect(await refusal(input())).toMatch(/its owner \(owner\.json\) cannot be read \(EACCES\)/);
    expect(spawned).toHaveLength(0);
    expect(heldLocks()).toEqual([]);
    expect(isGone(stuck.pid)).toBe(false);
    process.kill(stuck.pid, 'SIGKILL');
    await until(() => isGone(stuck.pid), 'stand-in Pi gone');
    await made.startSession(input());
    expect(spawned).toHaveLength(1);
    // Kept: whose it is stays unknown.
    expect(existsSync(run)).toBe(true);
  });

  it('R4-A: the owner of a launch is the identity the lock was taken with, not a later reading of it', async () => {
    const root = procOf([]);
    // This host's start time becomes unreadable after the lock was taken, while the launch is
    // prepared (its bridge config is written).
    fsFaults.write = async (file) => {
      if (file.endsWith('/config.json')) rmSync(join(root, String(process.pid)), { force: true });
    };
    const { session, entry } = await started(adapter({ procRoot: root }));
    const lock = join(sessionDir(), `${session.nativeSessionId}.lock`);
    const top = Math.max(
      ...readdirSync(lock)
        .map((name) => /^(\d+)\.owner$/.exec(name)?.[1])
        .filter((n): n is string => n !== undefined)
        .map(Number)
    );
    const taken = JSON.parse(readFileSync(join(lock, `${top}.owner`), 'utf8')) as {
      start: unknown;
    };
    const owner = JSON.parse(
      readFileSync(join(dirname(entry.config!.processRegistry), 'owner.json'), 'utf8')
    ) as { start: unknown };
    expect(typeof taken.start).toBe('string');
    expect(owner.start).toBe(taken.start);
  });

  it('R4-A: owner.json is written whole (a complete file renamed into place), never partly where a sweep would read it', async () => {
    const writes: string[] = [];
    fsFaults.write = async (file) => {
      writes.push(file);
    };
    const { entry } = await started();
    const runDir = dirname(entry.config!.processRegistry);
    // R3-E (joint round 4, U-5): written by `preparePiLaunch`, once, in the directory it makes
    // under `PI_RUN_PREPARING_PREFIX` (which the sweep removes), renamed into place with it.
    const owners = writes.filter((file) => file.endsWith('owner.json'));
    expect(owners).toEqual([
      expect.stringMatching(new RegExp(`/run/${PI_RUN_PREPARING_PREFIX}[^/]+/owner\\.json$`)),
    ]);
    expect(writes.filter((file) => dirname(file) === runDir)).toEqual([]);
    expect(JSON.parse(readFileSync(join(runDir, 'owner.json'), 'utf8'))).toMatchObject({
      v: 1,
      pid: process.pid,
      start: hostStart(),
    });
    expect(readdirSync(runDir).filter((name) => name.endsWith('.owner.json'))).toEqual([]);
  });

  it('R4-A: without its own start time the host starts no Pi and keeps no lock', async () => {
    const made = adapter({ procRoot: procOf([], { self: false }) });
    const error = await made.startSession(input()).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(/cannot read its own process start time/);
    expect(spawned).toHaveLength(0);
    expect(heldLocks()).toEqual([]);
  });

  /** A session whose first Pi was retired (a prompt it did not answer in time, R1-H). */
  async function retiredFirstPi() {
    const made = adapter({ promptTimeoutMs: 150 });
    const { given, entry } = await started(made);
    entry.pi.handlers.set('prompt', () => undefined);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'x' });
    await until(() => completed('t1').length === 1, 't1');
    await until(() => entry.pi.signals.includes('SIGTERM'), 'first Pi stopped');
    return { made, given };
  }

  for (const file of ['config.json', 'owner.json'] as const)
    it(`R4-B: a stop while the next Pi is prepared (${file} being written) ends that preparation; stopSession and stopAll settle only once its launch directory is gone`, async () => {
      const { made, given } = await retiredFirstPi();
      let held = null as string | null;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // `owner.json` is written as a whole file beside it, then renamed (R4-A): its write ends so.
      fsFaults.write = async (path) => {
        if (held !== null || !path.endsWith(file)) return;
        held = dirname(path);
        await gate;
      };
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'y' });
      await until(() => held !== null, `${file} of the next launch being written`);
      const runDir = held as unknown as string;
      expect(existsSync(runDir)).toBe(true);
      const seen: Array<Record<string, unknown>> = [];
      const note = (who: string) => () =>
        seen.push({
          who,
          exited: of('session.exited', given.sessionId).length,
          runDir: existsSync(runDir),
          locks: heldLocks().length,
        });
      const all = [
        made.stopSession(given.sessionId).then(note('stop')),
        made.stopAll().then(note('stopAll')),
      ];
      await pause(150);
      expect(seen).toEqual([]);
      expect(of('session.exited', given.sessionId)).toHaveLength(0);
      expect(heldLocks()).toHaveLength(1);
      release();
      await Promise.all(all);
      const done = { exited: 1, runDir: false, locks: 0 };
      expect(seen).toEqual(
        expect.arrayContaining([
          { who: 'stop', ...done },
          { who: 'stopAll', ...done },
        ])
      );
      // The preparation was ended: no second Pi, and the turn ended with the session.
      expect(spawned).toHaveLength(1);
      expect(completed('t2')).toHaveLength(1);
      const runs = join(stateDir(), 'run');
      expect(existsSync(runs) ? readdirSync(runs) : []).toEqual([]);
    });
});

describe('the Pi adapter: round 5 of stage 5 fixes (R5-A … R5-C, one life of a session)', () => {
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const ID = '0199a5c0-0000-7000-8000-0000000005b1';
  const warnings = () =>
    of('runtime.warning')
      .map((event) => event.message)
      .join('\n');
  const launches = () => {
    const dir = join(stateDir(), 'run');
    return existsSync(dir) ? readdirSync(dir) : [];
  };
  /** Every lock directory of a conversation, held or released. */
  const lockDirs = () =>
    existsSync(sessionDir())
      ? readdirSync(sessionDir()).filter((name) => name.endsWith('.lock'))
      : [];
  function gate() {
    let open!: () => void;
    const shut = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { shut, open };
  }
  const resume = () => input({ resume: { nativeSessionId: ID } });
  /**
   * A procfs of this process and its parent, an older process of this user (started before any
   * host here) whose environment cannot be read (EACCES), as `(sd-pam)` is on this machine.
   */
  function procWithOlder(): string {
    const root = mkdtempSync(join(home, 'proc-'));
    for (const pid of [process.pid, process.ppid])
      symlinkSync(`/proc/${pid}`, join(root, String(pid)));
    const environ = join(root, String(process.ppid), 'environ');
    fsFaults.read = (file) => (file === environ ? 'EACCES' : null);
    return root;
  }
  /**
   * Conversation `ID` as a host that is gone left it after a stop it could not confirm: its
   * transcript, the lock it held, a launch directory (with its `owner.json` or without), and the
   * record of cleanup that lists the launch (with the host's identity, or as written before round 5).
   */
  function leftWithRecord(options: { ownerJson: boolean; ownerInRecord: boolean }) {
    const transcript = writeTranscript(ID, join(home, 'project'));
    const lock = join(sessionDir(), `${ID}.lock`);
    mkdirSync(lock, { recursive: true });
    writeFileSync(
      join(lock, '1.owner'),
      JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart() })
    );
    const run = join(stateDir(), 'run', 'left-run');
    mkdirSync(run, { recursive: true });
    if (options.ownerJson)
      writeFileSync(
        join(run, 'owner.json'),
        JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart(), piSessionId: ID })
      );
    const record = join(sessionDir(), `${ID}.cleanup.json`);
    const launch = {
      runDir: run,
      registry: join(run, 'processes.jsonl'),
      bridgeConfig: join(run, 'config.json'),
      ...(options.ownerInRecord ? { owner: { pid: process.pid, start: deadHostStart() } } : {}),
    };
    writeFileSync(record, JSON.stringify({ v: 1, launches: [launch] }));
    return { run, record, transcript };
  }
  /** After a session of `ID` was resumed and stopped: its recovery goes ahead (a cut-off line). */
  function recoverable(transcript: string) {
    writeFileSync(transcript, '{"type":"message","id":"cut', { flag: 'a' });
    return piConversationStore().recover(sessionDir(), ID);
  }

  it('R5-A: a stop while the next Pi’s transcript is read ends that turn: no Pi is prepared after it, and the stop settles only once the turn’s operation ended', async () => {
    const made = adapter({ promptTimeoutMs: 150 });
    const { given, entry, session } = await started(made);
    entry.pi.handlers.set('prompt', () => undefined);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'x' });
    await until(() => completed('t1').length === 1, 't1');
    await until(() => entry.pi.signals.includes('SIGTERM'), 'first Pi stopped');
    // The next Pi resumes the conversation: its transcript is checked first, and held here.
    const transcript = writeTranscript(session.nativeSessionId, given.cwd);
    const reading = gate();
    let read = false;
    fsFaults.readAsync = async (file) => {
      if (file !== transcript) return;
      read = true;
      await reading.shut;
    };
    const writes: string[] = [];
    fsFaults.write = async (file) => {
      writes.push(file);
    };
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'y' });
    await until(() => read, 'transcript being read');
    let settled = false;
    const stopping = made.stopSession(given.sessionId).then(() => {
      settled = true;
    });
    await pause(100);
    expect(settled).toBe(false);
    expect(of('session.exited', given.sessionId)).toHaveLength(0);
    reading.open();
    await stopping;
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
    // No `preparePiLaunch` after the stop (it writes the launch's config.json), no second Pi.
    expect(writes.filter((file) => file.endsWith('config.json'))).toEqual([]);
    expect(spawned).toHaveLength(1);
    expect(launches()).toEqual([]);
    expect(heldLocks()).toEqual([]);
    expect(completed('t2')).toHaveLength(1);
  });

  for (const kind of ['session', 'discovery'] as const)
    it(`R5-A: a stop asked for by a listener of “starting” finds the start (${kind}): session.exited comes once the start ended, and nothing of it ran or is left`, async () => {
      const calls = join(home, 'pi-calls');
      writeFileSync(join(home, 'bin', 'pi'), `#!/bin/sh\necho x >> '${calls}'\necho 1.4.0\n`, {
        mode: 0o755,
      });
      const made = adapter();
      const given = kind === 'session' ? input() : input({ model: undefined, mcpServers: {} });
      const asked: { stop: Promise<void> | null } = { stop: null };
      const atExit: Array<Record<string, unknown>> = [];
      made.subscribe((event) => {
        if (event.sessionId !== given.sessionId) return;
        if (event.type === 'session.state.changed' && event.status === 'starting')
          asked.stop = made.stopSession(given.sessionId);
        if (event.type === 'session.exited')
          atExit.push({ session: made.hasSession(given.sessionId), locks: lockDirs() });
      });
      const error = await made.startSession(given).catch((caught: unknown) => caught);
      expect(asked.stop).not.toBeNull();
      await asked.stop;
      await pause(300);
      expect(String(error)).toMatch(/stopped while it started/);
      expect(atExit).toEqual([{ session: false, locks: [] }]);
      expect(of('session.exited', given.sessionId)).toHaveLength(1);
      // The start went no further than `starting`: no conversation taken, no Pi asked for its
      // version (`preparePiLaunch`), no launch, no Pi.
      expect(lockDirs()).toEqual([]);
      expect(existsSync(calls)).toBe(false);
      expect(launches()).toEqual([]);
      expect(spawned).toHaveLength(0);
    });

  it('R5-B: the record keeps the identity of the host that made the launch: with its owner.json gone, an older process of this user (EACCES) is left out, and the resume and the recovery go ahead', async () => {
    const { run, record, transcript } = leftWithRecord({ ownerJson: false, ownerInRecord: true });
    const made = adapter({ procRoot: procWithOlder() });
    const session = await made.startSession(resume());
    expect(session.nativeSessionId).toBe(ID);
    expect(spawned).toHaveLength(1);
    expect(existsSync(record)).toBe(false);
    expect(existsSync(run)).toBe(false);
    await made.stopSession(session.sessionId);
    expect(recoverable(transcript)).toMatchObject({ status: 'preview' });
  });

  it('R5-B: the sweep of a dead host settles the record of the conversation it starts (ended, directory, entry), so that no start or recovery refuses it afterwards', async () => {
    // A record as written before round 5 (no identity): the launch's owner.json is the one there is.
    const { run, record, transcript } = leftWithRecord({ ownerJson: true, ownerInRecord: false });
    expect(piConversationStore().recover(sessionDir(), ID)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/resume the conversation in Switch once/),
    });
    const made = adapter({ procRoot: procWithOlder() });
    const session = await made.startSession(resume());
    expect(session.nativeSessionId).toBe(ID);
    expect(existsSync(run)).toBe(false);
    expect(existsSync(record)).toBe(false);
    await made.stopSession(session.sessionId);
    expect(recoverable(transcript)).toMatchObject({ status: 'preview' });
  });

  for (const [by, ownerJson] of [
    ['the record check', false],
    ['the sweep of a dead host', true],
  ] as const)
    it(`R5-B: interrupted between the removal of the launch directory and that of its entry (${by}), the record says the launch ended: the next start settles it, without a loop of refusals`, async () => {
      const { run, record } = leftWithRecord({ ownerJson, ownerInRecord: true });
      const root = procWithOlder();
      // The entry cannot be removed right after the directory went (the session directory turns
      // read-only), as if Switch was stopped in between.
      fsFaults.rm = async (file, real) => {
        await real();
        if (file === run) chmodSync(sessionDir(), 0o500);
      };
      const made = adapter({ procRoot: root });
      let first: unknown;
      try {
        first = await made.startSession(resume()).catch((caught: unknown) => caught);
      } finally {
        chmodSync(sessionDir(), 0o700);
        fsFaults.rm = null;
      }
      expect(first).toBeInstanceOf(ProviderSessionError);
      expect(String(first)).toMatch(
        /its directory or its record entry could not be removed|could not settle its record/
      );
      expect(existsSync(run)).toBe(false);
      expect(JSON.parse(readFileSync(record, 'utf8'))).toMatchObject({
        launches: [{ runDir: run, ended: true }],
      });
      expect(heldLocks()).toEqual([]);
      expect(spawned).toHaveLength(0);
      // An entry that says the launch ended does not refuse the recovery either.
      expect(piConversationStore().recover(sessionDir(), ID)).toMatchObject({ status: 'whole' });
      const session = await made.startSession(resume());
      expect(session.nativeSessionId).toBe(ID);
      expect(existsSync(record)).toBe(false);
      expect(spawned).toHaveLength(1);
    });

  it('R5: the end of a session ends its waits on Pi at once, also when stopping that Pi does not cut them off', async () => {
    configure = (pi) => pi.handlers.set('get_commands', () => undefined);
    // `dispose` resolves without rejecting what waits on that Pi (the real one rejects it).
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockResolvedValue(undefined);
    const made = adapter({ startTimeoutMs: 4000 });
    const given = input();
    const starting = made.startSession(given).catch((caught: unknown) => caught);
    await until(() => spawned.length === 1, 'Pi spawned');
    await until(
      () => spawned[0]!.pi.received.some((c) => c.type === 'get_commands'),
      'get_commands'
    );
    const before = Date.now();
    await made.stopSession(given.sessionId);
    expect(Date.now() - before).toBeLessThan(2000);
    expect(String(await starting)).toMatch(/stopped while it started/);
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
    expect(heldLocks()).toEqual([]);
  });

  it('R5-B: a launch directory that is gone is no proof that its processes ended: the start is refused while the record does not say they did', async () => {
    const { run, record } = leftWithRecord({ ownerJson: false, ownerInRecord: true });
    rmSync(run, { recursive: true, force: true });
    const error = await adapter({ procRoot: procWithOlder() })
      .startSession(resume())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProviderSessionError);
    expect(String(error)).toMatch(/is gone and the record does not say its processes ended/);
    expect(existsSync(record)).toBe(true);
    expect(spawned).toHaveLength(0);
  });

  it('R5-C: a launch directory a stopped start could not remove keeps the conversation (recorded, the lock kept, the error said); stopping again settles it, and the recovery goes ahead', async () => {
    const writing = gate();
    let held = null as string | null;
    fsFaults.write = async (file) => {
      if (held !== null || !file.endsWith('owner.json')) return;
      held = dirname(file);
      await writing.shut;
    };
    const made = adapter();
    const given = input();
    const starting = made.startSession(given).catch((caught: unknown) => caught);
    await until(() => held !== null, 'owner.json being written');
    // U-5 (R3-E): `owner.json` is written in the directory `preparePiLaunch` makes; renamed into
    // place, that directory is the launch, and its removal fails.
    fsFaults.rm = async (file, real) => {
      if (inPlace(file))
        throw Object.assign(new Error(`EACCES: ${file} (test)`), { code: 'EACCES' });
      return real();
    };
    const stopping = made.stopSession(given.sessionId);
    writing.open();
    await stopping;
    expect(String(await starting)).toMatch(/stopped while it started/);
    expect(spawned).toHaveLength(0);
    expect(launchesInPlace()).toHaveLength(1);
    const runDir = launchesInPlace()[0] as string;
    expect(existsSync(join(runDir, 'owner.json'))).toBe(true);
    expect(heldLocks()).toHaveLength(1);
    expect(warnings()).toMatch(/could not remove launch directory .* it made \(EACCES\)/);
    const id = (heldLocks()[0] as string).slice(0, -'.lock'.length);
    const record = join(sessionDir(), `${id}.cleanup.json`);
    expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({
      v: 1,
      launches: [
        {
          runDir,
          registry: join(runDir, 'processes.jsonl'),
          bridgeConfig: join(runDir, 'config.json'),
          owner: { pid: process.pid, start: hostStart() },
          ended: true,
        },
      ],
    });
    const transcript = writeTranscript(id, given.cwd);
    writeFileSync(transcript, '{"type":"message","id":"cut', { flag: 'a' });
    expect(piConversationStore().recover(sessionDir(), id)).toMatchObject({
      status: 'refused',
      reason: expect.stringMatching(/open in Switch/),
    });
    // Stopping the session again tries once more; now the directory goes.
    fsFaults.rm = null;
    await made.stopSession(given.sessionId);
    expect(existsSync(runDir)).toBe(false);
    expect(heldLocks()).toEqual([]);
    expect(existsSync(record)).toBe(false);
    expect(piConversationStore().recover(sessionDir(), id)).toMatchObject({ status: 'preview' });
  });
});

/** What a duty of the adapter (D-16) looks like from a test; read through the adapter's privates. */
interface DutyView {
  id: number;
  sessionId: string;
  piSessionId: string;
  remove: Array<{ runDir: string }>;
  unrecorded: Array<{ runDir: string }>;
  release: unknown;
}
interface SessionView {
  piSessionId: string;
  generations: Array<{ launch: { runDir?: string } }>;
  blocked: unknown;
}
function internals(made: InstanceType<typeof PiAdapter>) {
  return made as unknown as {
    duties: Set<DutyView>;
    sessions: Map<string, SessionView>;
    ending: Set<unknown>;
  };
}
const dutiesOf = (made: InstanceType<typeof PiAdapter>) => [...internals(made).duties];
const eio = (file: string) => Object.assign(new Error(`EIO: ${file} (test)`), { code: 'EIO' });
const allWarnings = () =>
  of('runtime.warning')
    .map((event) => event.message)
    .join('\n');
const runDirs = () => {
  const dir = join(stateDir(), 'run');
  return existsSync(dir) ? readdirSync(dir).map((name) => join(dir, name)) : [];
};
/** Every launch the records of cleanup beside the conversations list. */
function recorded(): Set<string> {
  const dirs = new Set<string>();
  if (!existsSync(sessionDir())) return dirs;
  for (const name of readdirSync(sessionDir()).filter((file) => file.endsWith('.cleanup.json'))) {
    try {
      const record = JSON.parse(readFileSync(join(sessionDir(), name), 'utf8')) as {
        launches: Array<{ runDir: string }>;
      };
      for (const launch of record.launches) dirs.add(launch.runDir);
    } catch {
      dirs.add(`unreadable ${name}`);
    }
  }
  return dirs;
}
/** R7-D: every record of cleanup beside the conversations, whatever it lists (an empty one too). */
function recordFiles(): string[] {
  if (!existsSync(sessionDir())) return [];
  return readdirSync(sessionDir()).filter((file) => file.endsWith('.cleanup.json'));
}
/** R7-D: whether a process the test started lives (procfs of the system; a zombie is gone). */
function decoyAlive(pid: number): boolean {
  const found = readPiProcStat(pid);
  return found !== undefined && found.state !== 'Z' && found.state !== 'X';
}
/** A procfs of this process and its parent only (and `more`): scans see little, and see it fast. */
function smallProc(more: number[] = []): string {
  const root = mkdtempSync(join(home, 'proc-'));
  for (const pid of [process.pid, process.ppid, ...more])
    symlinkSync(`/proc/${pid}`, join(root, String(pid)));
  return root;
}

describe('the Pi adapter: round 6 of stage 5 fixes (D-16 A′: one owner of duties; R6-A … R6-C, D16-C1, D16-C2, D16-S1; D-15 part 2)', () => {
  const ID = '0199a5c0-0000-7000-8000-0000000006b1';
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const recordOf = (id: string) => join(sessionDir(), `${id}.cleanup.json`);
  function nest(depth: number, work: () => void): void {
    if (depth === 0) work();
    else queueMicrotask(() => nest(depth - 1, work));
  }

  it('R6-A: a launch directory of a generation whose processes ended that cannot be removed does not end the end early: every generation is gone through, session.exited comes, the directory is recorded as ended and the lock kept; stopping again settles it', async () => {
    const made = adapter({ promptTimeoutMs: 150 });
    const { given, entry, session } = await started(made);
    entry.pi.handlers.set('prompt', () => undefined);
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't1', text: 'x' });
    await until(() => completed('t1').length === 1, 't1');
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't2', text: 'y' });
    await until(() => spawned.length === 2 && prompts(last().pi).length === 1, 'new Pi');
    const first = dirname(entry.config!.processRegistry);
    const second = dirname(last().config!.processRegistry);
    let tries = 0;
    fsFaults.rm = async (file, real) => {
      if (file !== first) return real();
      tries += 1;
      throw eio(file);
    };
    await made.stopSession(given.sessionId);
    // Once by the end, once more by the stop (what the session id left is tried again, R5-C).
    expect(tries).toBe(2);
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
    expect(completed('t2')).toHaveLength(1);
    // The loop went on past the directory it could not remove.
    expect(existsSync(first)).toBe(true);
    expect(existsSync(second)).toBe(false);
    expect(allWarnings()).toMatch(/could not remove launch directory .* \(EIO\)/);
    expect(JSON.parse(readFileSync(recordOf(session.nativeSessionId), 'utf8'))).toEqual({
      v: 1,
      launches: [
        {
          runDir: first,
          registry: join(first, 'processes.jsonl'),
          bridgeConfig: join(first, 'config.json'),
          owner: { pid: process.pid, start: hostStart() },
          ended: true,
        },
      ],
    });
    expect(heldLocks()).toEqual([`${session.nativeSessionId}.lock`]);
    expect(dutiesOf(made)).toHaveLength(1);
    // A stop while the error lasts: tried again, nothing thrown, the duty kept.
    await made.stopSession(given.sessionId);
    expect(tries).toBe(3);
    expect(dutiesOf(made)).toHaveLength(1);
    fsFaults.rm = null;
    await made.stopSession(given.sessionId);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(recordOf(session.nativeSessionId))).toBe(false);
    expect(heldLocks()).toEqual([]);
    expect(dutiesOf(made)).toEqual([]);
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
  });

  it('R6-B: a stop any number of microtasks after the cleanup check passed never leaves a message accepted and unrun: it is refused, or it runs to its end', async () => {
    const outcomes: string[] = [];
    for (let depth = 0; depth <= 14; depth += 1) {
      const made = adapter();
      const { given, entry } = await started(made);
      const id = given.sessionId;
      const live = internals(made).sessions.get(id) as SessionView;
      live.blocked = {
        reason: 'a test block',
        recheck: async () => {
          nest(depth, () => void made.stopSession(id));
          return { confirmed: true, killed: 0, unconfirmed: [] };
        },
      };
      const turnId = `late-${depth}`;
      const outcome = await made
        .sendTurn({ sessionId: id, turnId, text: 'y' })
        .then(() => 'accepted')
        .catch((caught: unknown) => String(caught));
      await made.stopSession(id);
      outcomes.push(outcome === 'accepted' ? 'accepted' : 'refused');
      if (outcome === 'accepted') {
        // Accepted: it ends, as every message the session took (`turn.completed`).
        expect(completed(turnId)).toHaveLength(1);
      } else {
        expect(outcome).toMatch(
          /stopped while Switch checked its cleanup, and the message did not run/
        );
        expect(completed(turnId)).toHaveLength(0);
        expect(of('turn.started').filter((event) => event.turnId === turnId)).toHaveLength(0);
        expect(prompts(entry.pi)).toHaveLength(0);
      }
    }
    // Both ends of the window were reached: a stop before the check and one after the message.
    expect(outcomes).toContain('refused');
    expect(outcomes.at(-1)).toBe('accepted');
  });

  it('R6-B: a session whose id was taken again meanwhile does not take the message of the earlier one', async () => {
    const made = adapter();
    const { given } = await started(made);
    const id = given.sessionId;
    const live = internals(made).sessions.get(id) as SessionView;
    let replaced = false;
    live.blocked = {
      reason: 'a test block',
      recheck: async () => {
        // The session is gone from the adapter meanwhile (its end), and another took its id.
        internals(made).sessions.set(id, { ...live } as SessionView);
        replaced = true;
        return { confirmed: true, killed: 0, unconfirmed: [] };
      },
    };
    const error = await made
      .sendTurn({ sessionId: id, turnId: 'other', text: 'y' })
      .catch((caught: unknown) => caught);
    expect(replaced).toBe(true);
    expect(error).toBeInstanceOf(ProviderSessionError);
    internals(made).sessions.set(id, live);
    await made.stopSession(id);
    expect(completed('other')).toHaveLength(0);
  });

  it('R6-C: a release of the conversation whose write fails is kept and tried again: the session ends, the lock stays with this host (said), and the next stop lets it go', async () => {
    const made = adapter();
    const { given, session } = await started(made);
    let failures = 0;
    io.state.on = (call) =>
      call.op === 'openSync' && call.file.includes('.released.') && failures++ < 3
        ? 'before'
        : null;
    await made.stopSession(given.sessionId);
    // Once by the end, once more by the stop.
    expect(failures).toBe(2);
    expect(of('session.exited', given.sessionId)).toHaveLength(1);
    expect(heldLocks()).toEqual([`${session.nativeSessionId}.lock`]);
    expect(allWarnings()).toMatch(
      /could not let Pi conversation .* go \(the release of its lock, EIO\)/
    );
    expect(dutiesOf(made)).toMatchObject([
      {
        sessionId: given.sessionId,
        piSessionId: session.nativeSessionId,
        remove: [],
        unrecorded: [],
      },
    ]);
    await made.stopSession(given.sessionId);
    expect(failures).toBe(3);
    expect(heldLocks()).toEqual([`${session.nativeSessionId}.lock`]);
    await made.stopAll();
    expect(failures).toBe(4);
    expect(heldLocks()).toEqual([]);
    expect(dutiesOf(made)).toEqual([]);
    // Released once: a later start of the conversation takes it.
    const next = adapter();
    const error = await next
      .startSession(input({ resume: { nativeSessionId: session.nativeSessionId } }))
      .catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/has no saved conversation/);
  });

  it('D16-C1: a lock taken whose check after the link fails is the session’s to let go: the start is refused, and a release that fails too is kept and tried again', async () => {
    const made = adapter();
    const given = input();
    let linked = false;
    let releases = 0;
    io.state.on = (call) => {
      if (call.op === 'linkSync') linked = true;
      else if (linked && call.op === 'readdirSync' && call.file.endsWith('.lock')) {
        linked = false;
        return 'before';
      } else if (call.op === 'openSync' && call.file.includes('.released.') && releases++ < 1)
        return 'before';
      return null;
    };
    const error = await made.startSession(given).catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/could not take Pi conversation .* after taking it \(EIO\)/);
    expect(spawned).toHaveLength(0);
    expect(heldLocks()).toHaveLength(1);
    expect(dutiesOf(made)).toMatchObject([
      { sessionId: given.sessionId, remove: [], unrecorded: [] },
    ]);
    io.state.on = null;
    await made.stopSession(given.sessionId);
    expect(heldLocks()).toEqual([]);
    expect(dutiesOf(made)).toEqual([]);
  });

  it('D16-C2: a duty has its own identity: a session id taken again for another conversation does not lose the duty of the earlier one; stopping that id settles both', async () => {
    const made = adapter();
    const sessionId = 's-reused';
    const left: string[] = [];
    for (const round of [1, 2]) {
      const writing = (() => {
        let open!: () => void;
        const shut = new Promise<void>((resolve) => {
          open = resolve;
        });
        return { shut, open };
      })();
      let held = null as string | null;
      fsFaults.write = async (file) => {
        if (held !== null || !file.endsWith('owner.json')) return;
        held = dirname(file);
        await writing.shut;
      };
      const starting = made.startSession(input({ sessionId })).catch((caught: unknown) => caught);
      await until(() => held !== null, `owner.json being written (${round})`);
      // U-5 (R3-E): the launch is in place once `preparePiLaunch` renamed it there; every launch
      // in place fails to go until the end of the test.
      fsFaults.rm = async (file, real) => {
        if (inPlace(file)) throw eio(file);
        return real();
      };
      // `stopAll`: a stop of the id itself would try the earlier duty again first.
      const stopping = made.stopAll();
      writing.open();
      await stopping;
      expect(String(await starting)).toMatch(/stopped while it started/);
      const made_ = launchesInPlace().filter((dir) => !left.includes(dir));
      expect(made_).toHaveLength(1);
      left.push(...made_);
      fsFaults.write = null;
    }
    const mine = dutiesOf(made).filter((duty) => duty.sessionId === sessionId);
    expect(mine).toHaveLength(2);
    expect(new Set(mine.map((duty) => duty.piSessionId)).size).toBe(2);
    expect(new Set(mine.map((duty) => duty.id)).size).toBe(2);
    expect(heldLocks()).toHaveLength(2);
    fsFaults.rm = null;
    await made.stopSession(sessionId);
    expect(heldLocks()).toEqual([]);
    expect(dutiesOf(made)).toEqual([]);
    for (const dir of left) expect(existsSync(dir)).toBe(false);
  });

  it('D16-S1: a dead host’s launch directory that cannot be removed blocks its own conversation only: other conversations start, and it starts once the directory goes', async () => {
    const dead = (name: string, id: string) => {
      const dir = join(stateDir(), 'run', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'owner.json'),
        JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart(), piSessionId: id })
      );
      return dir;
    };
    const stuck = dead('dead-x', ID);
    const other = dead('dead-y', '0199a5c0-0000-7000-8000-0000000006b2');
    fsFaults.rm = async (file, real) => {
      if (file === stuck) throw eio(file);
      return real();
    };
    const made = adapter();
    const fresh = await made.startSession(input());
    expect(existsSync(other)).toBe(false);
    expect(existsSync(stuck)).toBe(true);
    await made.stopSession(fresh.sessionId);
    writeTranscript(ID, join(home, 'project'));
    const error = await made
      .startSession(input({ resume: { nativeSessionId: ID } }))
      .catch((caught: unknown) => caught);
    expect(String(error)).toMatch(
      /ended every process of launch .*dead-x but could not remove its directory \(EIO\)/
    );
    fsFaults.rm = null;
    const resumed = await made.startSession(input({ resume: { nativeSessionId: ID } }));
    expect(resumed.nativeSessionId).toBe(ID);
    expect(existsSync(stuck)).toBe(false);
  });

  describe('D-15 part 2: without procfs (an empty mount point, a fake ps), nothing that cannot be seen is taken for gone', () => {
    /**
     * The system's `ps`, showing only the processes of `pids` (as a machine where those are all
     * there is): every column as `ps` prints it, whatever the caller asks for. `-p` of another pid
     * finds none (exit 1, nothing printed). `fail`: it exits 3 and prints nothing.
     */
    function fakePs(pids: number[], fail = false): string {
      const dir = mkdtempSync(join(home, 'ps-'));
      const allow = join(dir, 'pids');
      writeFileSync(allow, pids.map((pid) => `${pid}\n`).join(''));
      const script = join(dir, 'ps');
      writeFileSync(
        script,
        [
          '#!/bin/sh',
          ...(fail ? ['exit 3'] : []),
          'prev=; pid=',
          'for a in "$@"; do [ "$prev" = "-p" ] && pid="$a"; prev="$a"; done',
          `if [ -n "$pid" ]; then grep -qx "$pid" '${allow}' || exit 1; exec ps "$@"; fi`,
          `ps "$@" | awk 'NR == FNR { ok[$1] = 1; next } ($1 in ok)' '${allow}' -`,
          '',
        ].join('\n'),
        { mode: 0o755 }
      );
      return script;
    }
    /** `lstart` of a process as `ps` prints it (`LC_ALL=C`, `TZ=UTC`), whitespace collapsed. */
    const lstartOf = (pid: number) =>
      realChild
        .spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
          encoding: 'utf8',
          env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
        })
        .stdout.trim()
        .replace(/\s+/g, ' ');

    it('an empty procfs mount point is no procfs: the session runs and ends through ps, and a Pi that did not exit is never taken for gone', async () => {
      const proc = join(home, 'empty-proc');
      mkdirSync(proc);
      const ps = fakePs([process.pid]);
      const made = adapter({ procRoot: proc, ps });
      const { given, entry, session } = await started(made);
      // The lock was taken with the start time `ps` gave (procfs would give clock ticks).
      const lock = join(sessionDir(), `${session.nativeSessionId}.lock`);
      expect(JSON.parse(readFileSync(join(lock, '1.owner'), 'utf8'))).toMatchObject({
        start: expect.stringMatching(/^ps:\S/),
      });
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
      await until(() => prompts(entry.pi).length === 1, 'prompt');
      await made.stopSession(given.sessionId);
      expect(existsSync(dirname(entry.config!.processRegistry))).toBe(false);
      expect(heldLocks()).toEqual([]);
      // A Pi whose exit `dispose` did not see: without procfs no environment can be read.
      const second = await started(made);
      vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(new Error('did not exit'));
      await made.stopSession(second.given.sessionId);
      vi.restoreAllMocks();
      const runDir = dirname(second.entry.config!.processRegistry);
      expect(existsSync(runDir)).toBe(true);
      expect(
        JSON.parse(readFileSync(recordOf(second.session.nativeSessionId), 'utf8'))
      ).toMatchObject({
        launches: [{ runDir }],
      });
      expect(allWarnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    });

    it('a group is checked the way the view reads processes (ps when there is no procfs), its count comes from ps, and its markers, unreadable there, keep it unconfirmed', async () => {
      const proc = join(home, 'empty-proc');
      mkdirSync(proc);
      const registry = join(home, 'reg.jsonl');
      const group = startGroup('sleep 60', 'm-ps6');
      const base = { v: 1, instance: 'i-1', toolCallId: 'c', run: 1, marker: tagged('m-ps6') };
      writeFileSync(
        registry,
        `${JSON.stringify({ ...base, event: 'intent' })}\n${JSON.stringify({ ...base, event: 'spawn', pid: group.pid, pgid: group.pid, lstart: lstartOf(group.pid) })}\n`
      );
      // A `ps` that fails: the group's check went to `ps` (procfs on the empty directory would
      // have found the group empty, not unknown), and no table is taken for an empty one.
      const failing = await killPiBashGroups(registry, () => true, {
        includeUnspawned: true,
        procRoot: proc,
        ps: fakePs([], true),
        timeoutMs: 100,
      });
      expect(failing.confirmed).toBe(false);
      expect(failing.unconfirmed.join('; ')).toMatch(/c: state unknown \(exit 3\)/);
      expect(failing.unconfirmed.join('; ')).toMatch(/process table could not be read/);
      expect(liveMembers(group.pid)).toBeGreaterThan(0);
      // A `ps` that sees the group: never confirmed while its markers cannot be read.
      const seen = await killPiBashGroups(registry, () => true, {
        includeUnspawned: true,
        procRoot: proc,
        ps: fakePs([process.pid, group.pid]),
        timeoutMs: 100,
      });
      expect(seen.confirmed).toBe(false);
      expect(seen.unconfirmed.join('; ')).toMatch(/markers of the commands could not be read/);
    });
  });

  /**
   * D-16 (A′, point 8): the test with an explicit matrix. Every place of I/O of the adapter and its
   * store that the families below reach (`io`: `file:line`, an alias of `pi-bash.ts` resolved to
   * the frame that called it, the chain of callers telling apart the same line reached from
   * elsewhere) is failed in turn, at its first call in the step under test: before its effect,
   * after it, after part of it (where an effect can be partial), once and for as long as it lasts.
   * The oracle checks the state, not only `session.exited`: every session that started ended
   * once, every message accepted has its `turn.completed`, no `prompt` after the stop, every held
   * lock is a live session's or a duty's, every launch directory a live session's, a duty's, the
   * record's or a dead host's (the sweep's), every duty has something to do, and what is left is
   * said. After the failure goes, a try (`stopSession`, `stopAll` or a start of the conversation)
   * and the next start of every conversation leave nothing: no duty, no lock, no launch, no record.
   * A place a case plans and does not reach makes it red. What this proves is the behaviour for
   * these places, these families and these failures; it does not rule out the class.
   */
  describe('D-16 matrix', () => {
    /**
     * The places of I/O (`file:line call`) the families reach, in the step under test, in the
     * healing after it, or on an error path only a failure leads to; see the inventory test.
     */
    const INVENTORY: string[] = [
      // Joint round 5: lines as after O-1 A, O-2 B and O-9 A′, mapped from joint round 4 by the
      // unchanged groups of `diff` (`RUN/scripts/joint-fix5/linemap.sh`); every one was unchanged.
      'pi-adapter.ts:513 lstat',
      'pi-adapter.ts:521 readFile',
      'pi-adapter.ts:555 readdirSync',
      'pi-adapter.ts:666 readdirSync',
      'pi-adapter.ts:675 readFileSync',
      'pi-adapter.ts:691 readFileSync',
      'pi-adapter.ts:735 readdirSync',
      'pi-adapter.ts:742 readFileSync',
      'pi-adapter.ts:861 readFileSync',
      'pi-adapter.ts:943 readFileSync',
      'pi-adapter.ts:1059 rename',
      'pi-adapter.ts:1065 rm',
      'pi-adapter.ts:1153 readdir',
      'pi-adapter.ts:1164 rm',
      'pi-adapter.ts:1200 readFile',
      'pi-adapter.ts:1647 lstat',
      'pi-adapter.ts:1719 realpath',
      'pi-adapter.ts:2296 readFile',
      'pi-conversation.ts:185 readdirSync',
      'pi-conversation.ts:237 readFileSync',
      'pi-conversation.ts:354 readdirSync',
      'pi-conversation.ts:364 readFileSync',
      'pi-conversation.ts:389 readFileSync',
      'pi-conversation.ts:482 readdirSync',
      'pi-conversation.ts:659 readFileSync',
      'pi-conversation.ts:752 openSync',
      'pi-conversation.ts:754 fsyncSync',
      'pi-conversation.ts:756 closeSync',
      'pi-conversation.ts:767 openSync',
      'pi-conversation.ts:770 writeFileSync',
      'pi-conversation.ts:771 fsyncSync',
      'pi-conversation.ts:773 closeSync',
      'pi-conversation.ts:775 renameSync',
      'pi-conversation.ts:779 rmSync',
      'pi-conversation.ts:789 rmSync',
      'pi-conversation.ts:798 readdirSync',
      'pi-conversation.ts:807 readFileSync',
      'pi-conversation.ts:816 existsSync',
      'pi-conversation.ts:869 rmSync',
      'pi-conversation.ts:886 mkdirSync',
      'pi-conversation.ts:896 writeFileSync',
      'pi-conversation.ts:899 linkSync',
      'pi-conversation.ts:905 statSync',
      'pi-conversation.ts:947 readdirSync',
      'pi-conversation.ts:981 readFileSync',
      'pi-conversation.ts:1001 existsSync',
      'pi-conversation.ts:1007 readdirSync',
      'pi-conversation.ts:1118 readFileSync',
      'pi-conversation.ts:1175 mkdirSync',
      'pi-conversation.ts:1257 existsSync',
      'pi-conversation.ts:1324 lstatSync',
      'pi-conversation.ts:1327 readFileSync',
      'pi-conversation.ts:1353 existsSync',
    ];
    /**
     * Lines of I/O of the two files no family reaches, and why (the static half of the inventory).
     * Every one is a read: a failure of it is a process or a group that cannot be seen (counted,
     * never taken for gone), and the tests named cover it.
     */
    const NOT_REACHED: Record<string, string> = {
      'pi-adapter.ts:587':
        'labelledProcesses without procfs (D-18): the families run on procfs; joint round 3 tests (labels, flows)',
      'pi-adapter.ts:624':
        'environFailure (R3-A): only for a process whose environment cannot be read (EACCES); round 3 tests',
      'pi-adapter.ts:626': 'environFailure (R3-A): the owner of /proc/<pid>; round 3 tests',
      'pi-adapter.ts:627': 'environFailure (R3-A): /proc/<pid>/status; round 3 tests',
      'pi-adapter.ts:722':
        'liveGroups without procfs (D-15): the families run on procfs; D-15 part 2 tests',
      'pi-adapter.ts:876':
        'signalPiBashGroup: only for a group in a registry (the families start no shell); R1-C, R2-D tests',
      'pi-adapter.ts:1074':
        'launchHostStart: only for a record without the host’s identity (written before round 5); R5-B tests',
      'pi-adapter.ts:1178':
        'sweepDeadHosts, a launch being made (O-9 A′): the owner of a .preparing- directory; only while one is there at a sweep (the families make none, and a start of theirs is never swept by another); joint round 5 tests (the other process, the table of steps)',
      'pi-conversation.ts:317': 'environFailure of the store (R3-A, EACCES); its round 3 tests',
      'pi-conversation.ts:318': 'environFailure of the store (R3-A, EACCES); its round 3 tests',
      'pi-conversation.ts:428':
        'liveGroups of the store on procfs: only for a launch with groups in its registry; R2-B, R4-A tests',
      'pi-conversation.ts:432': 'liveGroups of the store on procfs (as :428); R2-B, R4-A tests',
      'pi-conversation.ts:502':
        'launchesLeft: the owner of a launch left in run/ at a recovery; R2-B, R4-A tests',
      'pi-conversation.ts:559':
        'preparingLeft (O-9 A′): the owner of a launch being made, at a recovery; joint round 5 store tests',
      'pi-conversation.ts:852':
        'settler (R7-B): only behind two failures (a link made that answered an error, then its probe failed), in the release; joint round 3 tests (Codex A01)',
      'pi-conversation.ts:859': 'settler (R7-B, as :852); joint round 3 tests (Codex A01)',
      'pi-conversation.ts:1292':
        'recoverHeld (O-1 A): the directory of a launch whose record keeps Pi’s exit; only for such a record (the families confirm Pi’s exit or record none); joint round 5 store tests',
    };
    type Mode = 'before' | 'after' | 'partial';
    const READS = new Set([
      'readFile',
      'readdir',
      'lstat',
      'realpath',
      'readFileSync',
      'readdirSync',
      'statSync',
      'lstatSync',
      'existsSync',
      'fsyncSync',
    ]);
    const PARTIAL = new Set(['writeFile', 'writeFileSync', 'rm', 'rmSync']);
    const modesOf = (op: string): Mode[] =>
      READS.has(op)
        ? ['before']
        : op === 'closeSync'
          ? ['after']
          : PARTIAL.has(op)
            ? ['before', 'after', 'partial']
            : ['before', 'after'];

    interface World {
      made: InstanceType<typeof PiAdapter>;
      /** Conversations the family touches. */
      ids: Set<string>;
      sessionIds: Set<string>;
      accepted: string[];
      stopAt: number | null;
      errors: string[];
      /** A dead host's launch directories the fixture made: the sweep's, not a duty's. */
      deadDirs: string[];
      proc: string;
      /** Run by the healing before anything else (a stuck Pi's spy removed, a fixture fault). */
      lift?: () => void;
      /**
       * R7-D: where this world's own processes (decoys: `groups`) begin; the oracle reads their
       * life itself, whatever the adapter's bookkeeping says.
       */
      decoysFrom: number;
    }
    interface Family {
      name: string;
      fixture: (world: World) => Promise<void>;
      act: (world: World) => Promise<void>;
    }
    const promptCount = () => spawned.reduce((count, entry) => count + prompts(entry.pi).length, 0);
    /** Held locks whose holder still runs (one whose holder is gone is free, R1-D). */
    const liveLocks = () =>
      heldLocks().filter((name) => {
        const lock = join(sessionDir(), name);
        const top = Math.max(
          ...readdirSync(lock)
            .map((entry) => /^(\d+)\.owner$/.exec(entry)?.[1])
            .filter((n): n is string => n !== undefined)
            .map(Number)
        );
        try {
          const owner = JSON.parse(readFileSync(join(lock, `${top}.owner`), 'utf8')) as {
            pid: unknown;
            start: unknown;
          };
          return piConversationStore().stillRuns(owner.pid, owner.start);
        } catch {
          return true;
        }
      });
    async function begin(world: World, overrides: Partial<ProviderSessionStartInput> = {}) {
      const given = input(overrides);
      world.sessionIds.add(given.sessionId);
      try {
        const session = await world.made.startSession(given);
        if (session.nativeSessionId) world.ids.add(session.nativeSessionId);
        return { given, session, entry: last() };
      } catch (error) {
        world.errors.push(String(error));
        return null;
      }
    }
    async function turn(world: World, sessionId: string, turnId: string) {
      try {
        await world.made.sendTurn({ sessionId, turnId, text: 'x' });
        world.accepted.push(turnId);
      } catch (error) {
        world.errors.push(String(error));
      }
    }
    /** Every Pi answers a prompt with a run that settles at once. */
    function settling(): void {
      configure = (pi, entry) => {
        pi.handlers.set('prompt', () => {
          announce(pi, entry, nextRun(pi));
          setImmediate(() => settle(pi));
          return { data: { disposition: 'started' } };
        });
      };
    }
    async function quiet(world: World): Promise<void> {
      await until(() => internals(world.made).ending.size === 0, 'every end settled', 8000);
      for (let i = 0; i < 3; i += 1) await tick();
    }
    async function stopping(world: World, work: () => Promise<void>): Promise<void> {
      world.stopAt = promptCount();
      await work();
    }

    const FAMILIES: Family[] = [
      {
        name: 'stop after a turn',
        fixture: async (world) => {
          settling();
          const started = await begin(world);
          await turn(world, started!.given.sessionId, 't');
          await until(() => completed('t').length === 1, 'turn');
        },
        act: (world) =>
          stopping(world, () => world.made.stopSession([...world.sessionIds][0] as string)),
      },
      {
        name: 'stopAll while a turn runs',
        fixture: async (world) => {
          const started = await begin(world);
          await turn(world, started!.given.sessionId, 't');
          await until(() => prompts(started!.entry.pi).length === 1, 'prompt');
        },
        act: (world) => stopping(world, () => world.made.stopAll()),
      },
      {
        name: 'Pi goes away while a turn runs',
        fixture: async (world) => {
          const started = await begin(world);
          await turn(world, started!.given.sessionId, 't');
          await until(() => prompts(started!.entry.pi).length === 1, 'prompt');
        },
        act: async (world) => {
          world.stopAt = promptCount();
          last().pi.exit(1, null);
          await until(() => of('session.exited').length === 1, 'exited', 8000);
        },
      },
      {
        name: 'a start, a turn and its end',
        fixture: async () => {
          settling();
        },
        act: async (world) => {
          const started = await begin(world);
          if (!started) return;
          await turn(world, started.given.sessionId, 't');
          await until(
            () =>
              !world.accepted.includes('t') ||
              completed('t').length === 1 ||
              !world.made.hasSession(started.given.sessionId),
            'turn'
          );
          await stopping(world, () => world.made.stopSession(started.given.sessionId));
        },
      },
      {
        name: 'a stop whose Pi did not exit, then the next start of the conversation',
        fixture: async (world) => {
          const started = await begin(world);
          const stuck = startStuckPi(started!.entry.options.env!.SWITCH_PI_BRIDGE as string);
          symlinkSync(`/proc/${stuck.pid}`, join(world.proc, String(stuck.pid)));
          vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(new Error('did not exit'));
          world.lift = () => vi.restoreAllMocks();
        },
        act: async (world) => {
          await stopping(world, () => world.made.stopSession([...world.sessionIds][0] as string));
          vi.restoreAllMocks();
          const id = [...world.ids][0] as string;
          writeTranscript(id, join(home, 'project'));
          const resumed = await begin(world, { resume: { nativeSessionId: id } });
          if (resumed) await world.made.stopSession(resumed.given.sessionId);
        },
      },
      {
        name: 'a stop of a start that could not remove its launch directory, then a stop again',
        fixture: async (world) => {
          let open!: () => void;
          const shut = new Promise<void>((resolve) => {
            open = resolve;
          });
          let held = null as string | null;
          fsFaults.write = async (file) => {
            if (held !== null || !file.endsWith('owner.json')) return;
            held = dirname(file);
            await shut;
          };
          const given = input();
          world.sessionIds.add(given.sessionId);
          const starting = world.made.startSession(given).catch((caught: unknown) => caught);
          await until(() => held !== null, 'owner.json being written');
          // U-5 (R3-E): the launch is in place once `preparePiLaunch` renamed it there.
          fsFaults.rm = async (file, real) => {
            if (inPlace(file)) throw eio(file);
            return real();
          };
          const stopped = world.made.stopSession(given.sessionId);
          open();
          await stopped;
          world.errors.push(String(await starting));
          fsFaults.write = null;
          fsFaults.rm = null;
          for (const duty of dutiesOf(world.made)) world.ids.add(duty.piSessionId);
        },
        act: (world) => world.made.stopSession([...world.sessionIds][0] as string),
      },
      {
        name: 'a start that sweeps a dead host’s launches (one its conversation’s record lists)',
        fixture: async (world) => {
          const dead = (name: string, id: string) => {
            const dir = join(stateDir(), 'run', name);
            mkdirSync(dir, { recursive: true });
            writeFileSync(
              join(dir, 'owner.json'),
              JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart(), piSessionId: id })
            );
            world.deadDirs.push(dir);
            return dir;
          };
          dead('dead-other', '0199a5c0-0000-7000-8000-0000000006c2');
          const listed = dead('dead-own', ID);
          mkdirSync(sessionDir(), { recursive: true });
          writeFileSync(
            recordOf(ID),
            JSON.stringify({
              v: 1,
              launches: [
                {
                  runDir: listed,
                  registry: join(listed, 'processes.jsonl'),
                  bridgeConfig: join(listed, 'config.json'),
                  owner: { pid: process.pid, start: deadHostStart() },
                },
              ],
            })
          );
          writeTranscript(ID, join(home, 'project'));
          world.ids.add(ID);
        },
        act: async (world) => {
          const resumed = await begin(world, { resume: { nativeSessionId: ID } });
          if (resumed) await stopping(world, () => world.made.stopSession(resumed.given.sessionId));
        },
      },
      {
        name: 'a resume of a transcript cut off (the recovery written), a turn with an image',
        fixture: async (world) => {
          settling();
          const file = writeTranscript(ID, join(home, 'project'));
          writeFileSync(file, '{"type":"message","id":"cut', { flag: 'a' });
          writeFileSync(join(home, 'image.png'), 'png');
          world.ids.add(ID);
        },
        act: async (world) => {
          await begin(world, { resume: { nativeSessionId: ID } });
          const fresh = await begin(world);
          if (!fresh) return;
          try {
            await world.made.sendTurn({
              sessionId: fresh.given.sessionId,
              turnId: 'img',
              text: 'x',
              attachments: [{ path: join(home, 'image.png'), mimeType: 'image/png' }],
            } as Parameters<typeof world.made.sendTurn>[0]);
            world.accepted.push('img');
          } catch (error) {
            world.errors.push(String(error));
          }
          await until(
            () => !world.accepted.includes('img') || completed('img').length === 1,
            'image turn'
          );
          await stopping(world, () => world.made.stopSession(fresh.given.sessionId));
        },
      },
      {
        name: 'an interrupt that does not settle (the Pi retired), the next turn in a new Pi',
        fixture: async (world) => {
          const started = await begin(world);
          await turn(world, started!.given.sessionId, 't1');
          await until(() => prompts(started!.entry.pi).length === 1, 'prompt');
        },
        act: async (world) => {
          const sessionId = [...world.sessionIds][0] as string;
          await world.made.interruptTurn(sessionId);
          await until(() => completed('t1').length === 1, 't1 ended', 8000);
          settling();
          await turn(world, sessionId, 't2');
          // A message refused (a cleanup that still cannot be confirmed) is not waited for.
          await until(
            () =>
              !world.accepted.includes('t2') ||
              completed('t2').length === 1 ||
              !world.made.hasSession(sessionId),
            't2',
            8000
          );
          await stopping(world, () => world.made.stopSession(sessionId));
        },
      },
      {
        name: 'the recovery of a conversation (the administrative procedure)',
        fixture: async (world) => {
          const file = writeTranscript(ID, join(home, 'project'));
          writeFileSync(file, '{"type":"message","id":"cut', { flag: 'a' });
          world.ids.add(ID);
        },
        act: async (world) => {
          const store = piConversationStore({ procRoot: world.proc });
          let kept = '';
          const recover = (digest?: string) => {
            try {
              const result = store.recover(sessionDir(), ID, digest);
              if (result.status === 'refused') world.errors.push(result.reason);
              kept ||= result.lockKept ?? '';
              return result;
            } catch (error) {
              world.errors.push(String(error));
              kept ||= (error as { lockKept?: string }).lockKept ?? '';
              return null;
            }
          };
          const preview = recover();
          if (preview?.status === 'preview' && !kept) recover(preview.digest);
          if (kept) {
            world.errors.push(`lock kept: ${kept}`);
            // The procedure's process ends: its lock is free (its holder gone).
            const lock = join(sessionDir(), `${ID}.lock`);
            for (const name of readdirSync(lock).filter((entry) => entry.endsWith('.owner')))
              writeFileSync(
                join(lock, name),
                JSON.stringify({ v: 1, pid: process.pid, start: deadHostStart() })
              );
          }
        },
      },
    ];

    /** A home of its own for one case (the hooks of the file run once per `it`). */
    async function inWorld<T>(work: (world: World) => Promise<T>): Promise<T> {
      const before = home;
      home = mkdtempSync(join(tmpdir(), 'pi-matrix-'));
      mkdirSync(join(home, 'bin'));
      mkdirSync(join(home, 'project'));
      writeFileSync(join(home, 'bin', 'pi'), '#!/bin/sh\necho 1.4.0\n', { mode: 0o755 });
      events.length = 0;
      spawned.length = 0;
      configure = () => {};
      const world: World = {
        made: adapter({ procRoot: smallProc(), cleanupTimeoutMs: 40, interruptTimeoutMs: 30 }),
        ids: new Set(),
        sessionIds: new Set(),
        accepted: [],
        stopAt: null,
        errors: [],
        deadDirs: [],
        proc: '',
        decoysFrom: groups.length,
      };
      world.proc = (world.made as unknown as { view: { procRoot: string } }).view.procRoot;
      try {
        return await work(world);
      } finally {
        io.state.on = null;
        fsFaults.write = null;
        fsFaults.rm = null;
        vi.restoreAllMocks();
        await world.made.stopAll().catch(() => {});
        for (const pid of groups.splice(0)) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            // gone
          }
        }
        rmSync(home, { recursive: true, force: true });
        home = before;
      }
    }

    /** The oracle (see the describe): what is wrong with the world now; `healed`: nothing may be left. */
    function wrong(world: World, healed: boolean): string[] {
      // The oracle's own reads (a store's `stillRuns`) are not the world's: never failed.
      const on = io.state.on;
      io.state.on = null;
      try {
        return wrongNow(world, healed);
      } finally {
        io.state.on = on;
      }
    }
    function wrongNow(world: World, healed: boolean): string[] {
      const out: string[] = [];
      const inner = internals(world.made);
      const ledger = [...inner.duties];
      const live = [...inner.sessions.values()];
      for (const id of world.sessionIds) {
        const startedCount = of('session.started', id).length;
        const exited = of('session.exited', id).length;
        const running = inner.sessions.has(id);
        // A start stopped while it started says `session.exited` too (R1-F); one that failed does not.
        if (exited > 1 || (running && exited > 0) || (!running && startedCount > 0 && exited !== 1))
          out.push(
            `session ${id}: ${startedCount} started, ${exited} exited, ${running ? '' : 'not '}live`
          );
      }
      for (const turnId of world.accepted)
        if (completed(turnId).length !== 1)
          out.push(`message ${turnId}: ${completed(turnId).length} turn.completed`);
      if (world.stopAt !== null && promptCount() > world.stopAt)
        out.push('a prompt after the stop');
      for (const name of liveLocks()) {
        const id = name.slice(0, -'.lock'.length);
        if (
          !live.some((session) => session.piSessionId === id) &&
          !ledger.some((duty) => duty.piSessionId === id && duty.release)
        )
          out.push(`lock of ${id} held by no one`);
      }
      const inRecord = recorded();
      // The sweep's (every start tries them): a dead host's launches, and removals cut short.
      const sweeps = (dir: string) =>
        world.deadDirs.includes(dir) || basename(dir).startsWith('.removed-');
      for (const dir of runDirs()) {
        const ofLive = live.some((session) =>
          session.generations.some((generation) => generation.launch.runDir === dir)
        );
        const inLedger = ledger.some((duty) =>
          [...duty.remove, ...duty.unrecorded].some((launch) => launch.runDir === dir)
        );
        if (!ofLive && !inLedger && !inRecord.has(dir) && !sweeps(dir))
          out.push(`launch ${basename(dir)} is no one’s`);
      }
      for (const duty of ledger)
        if (duty.remove.length === 0 && duty.unrecorded.length === 0 && !duty.release)
          out.push(`duty ${duty.id} with nothing to do`);
      // What is left that blocks something is said (a duty, a record); the sweep's needs no word.
      const left = ledger.length > 0 || inRecord.size > 0;
      if (left && allWarnings() === '' && world.errors.length === 0)
        out.push('something is left and nothing said so');
      // R7-D: this world's own processes, read by the oracle itself (procfs of the system), never
      // through what the adapter kept of them: one that lives is a session's, a duty's or a
      // record's, and none lives once healed (before the test's own cleanup kills them).
      const decoys = groups.slice(world.decoysFrom).filter(decoyAlive);
      if (decoys.length > 0 && live.length === 0 && !left)
        out.push(`decoy(s) ${decoys.join(', ')} alive and nothing keeps them`);
      if (healed) {
        if (decoys.length > 0) out.push(`decoys alive: ${decoys.join(', ')}`);
        // R7-D: every record file, an empty one too (`recorded` reads the launches it lists).
        const files = recordFiles();
        if (files.length > 0) out.push(`record files left: ${files.join(', ')}`);
        if (ledger.length > 0) out.push(`${ledger.length} duties left`);
        if (liveLocks().length > 0) out.push(`locks left: ${liveLocks().join(', ')}`);
        if (runDirs().length > 0)
          out.push(
            `launches left: ${runDirs()
              .map((dir) => basename(dir))
              .join(', ')}`
          );
        if (inRecord.size > 0) out.push(`records left: ${[...inRecord].join(', ')}`);
        if (live.length > 0) out.push(`${live.length} sessions live`);
      }
      return out;
    }

    /** The failure gone: a try (`how`), then the next start of every conversation, and its end. */
    async function heal(
      world: World,
      how: 'stopSession' | 'stopAll' | 'start',
      watch: ((call: Hit) => Mode | null) | null = null
    ): Promise<void> {
      io.state.on = watch;
      fsFaults.write = null;
      fsFaults.rm = null;
      world.lift?.();
      configure = () => {};
      await quiet(world);
      for (const id of [...internals(world.made).sessions.keys()]) await world.made.stopSession(id);
      if (how === 'stopSession')
        for (const id of world.sessionIds) await world.made.stopSession(id);
      if (how === 'stopAll') await world.made.stopAll();
      for (const duty of dutiesOf(world.made)) world.ids.add(duty.piSessionId);
      // Also a conversation whose start was stopped before it said its id (its lock says it).
      if (existsSync(sessionDir()))
        for (const name of readdirSync(sessionDir()))
          if (name.endsWith('.lock')) world.ids.add(name.slice(0, -'.lock'.length));
      for (const id of world.ids) {
        const resumed = await begin(world, { resume: { nativeSessionId: id } });
        if (resumed) await world.made.stopSession(resumed.given.sessionId);
      }
      await quiet(world);
    }

    interface Hit {
      op: string;
      site: string;
      via: string | null;
      chain: string;
    }
    const keyOf = (hit: Hit) => `${hit.chain} ${hit.op}`;
    /** What every family reached, place by place (`file:line call`), and on which path. */
    const REACHED = new Map<string, { hit: Hit; families: Set<string>; paths: Set<string> }>();
    const familiesRun = new Set<string>();
    function reach(family: Family, hit: Hit, path: 'step' | 'healing' | 'error path'): void {
      const key = `${hit.site} ${hit.op}`;
      const known = REACHED.get(key) ?? { hit, families: new Set(), paths: new Set() };
      known.families.add(family.name);
      known.paths.add(path);
      REACHED.set(key, known);
    }
    /** The calls of the step under test and of the healing after it, in order (no failure). */
    async function trace(family: Family): Promise<{ step: Hit[]; healing: Hit[] }> {
      return inWorld(async (world) => {
        await family.fixture(world);
        const step: Hit[] = [];
        const healing: Hit[] = [];
        const into = (list: Hit[]) => (call: Hit) => {
          list.push({ op: call.op, site: call.site, via: call.via, chain: call.chain });
          return null;
        };
        io.state.on = into(step);
        await family.act(world);
        await quiet(world);
        io.state.on = null;
        const problems = wrong(world, false);
        if (problems.length > 0)
          throw new Error(`${family.name}, no failure: ${problems.join('; ')}`);
        await heal(world, 'stopAll', into(healing));
        const left = wrong(world, true);
        if (left.length > 0)
          throw new Error(`${family.name}, no failure, healed: ${left.join('; ')}`);
        return { step, healing };
      });
    }

    interface Case {
      family: Family;
      key: string;
      op: string;
      mode: Mode;
      lasting: boolean;
      how: 'stopSession' | 'stopAll' | 'start';
      /**
       * A second place failed once: the error path the first failure leads to, in the step or in
       * the healing after it (where the case first reached it).
       */
      extra?: { key: string; mode: Mode; phase: 'step' | 'healing' };
      /** The failure is in the healing (a place only the healing reaches): it heals twice. */
      inHealing?: boolean;
    }
    type Seen = Hit & { phase: 'step' | 'healing' };
    /**
     * One case: the family with its place failed; what was wrong (empty when nothing), and every
     * place the case reached (with the failure, and while it healed).
     */
    async function runCase(item: Case): Promise<{ problems: string[]; seen: Seen[] }> {
      return inWorld(async (world) => {
        await item.family.fixture(world);
        const seen: Seen[] = [];
        let reached = 0;
        let extra = 0;
        const note = (call: Hit, phase: Seen['phase']) =>
          seen.push({ op: call.op, site: call.site, via: call.via, chain: call.chain, phase });
        const failing =
          (phase: Seen['phase'], first: boolean) =>
          (call: Hit): Mode | null => {
            note(call, phase);
            const key = keyOf(call);
            if (item.extra?.phase === phase && key === item.extra.key && (extra += 1) === 1)
              return item.extra.mode;
            if (!first || key !== item.key) return null;
            reached += 1;
            return reached === 1 || item.lasting ? item.mode : null;
          };
        const plan = failing('step', !item.inHealing);
        const watch = failing('healing', false);
        io.state.on = item.inHealing ? failing('step', false) : plan;
        const act = item.family.act(world).then(
          () => null,
          (error: unknown) => `the step threw: ${errorMessage(error)}`
        );
        const thrown = await Promise.race([
          act,
          pause(10_000).then(() => 'the step did not end in 10 s'),
        ]);
        const out: string[] = [];
        if (thrown) out.push(thrown);
        try {
          await quiet(world);
        } catch (error) {
          out.push(errorMessage(error));
        }
        if (item.inHealing) {
          out.push(...wrong(world, false));
          await heal(world, item.how, failing('healing', true));
          out.push(...wrong(world, false).map((problem) => `while it heals: ${problem}`));
        } else out.push(...wrong(world, false));
        if (item.lasting) {
          // While it lasts: every try ends, keeps what it owns, and says what is left.
          await world.made.stopAll();
          out.push(...wrong(world, false).map((problem) => `while it lasts: ${problem}`));
        }
        if (item.extra?.phase === 'healing') {
          await heal(world, item.how, watch);
          out.push(...wrong(world, false).map((problem) => `while it heals: ${problem}`));
        }
        if (reached === 0) out.push('the planned place was not reached');
        if (item.extra && extra === 0) out.push('the second place was not reached');
        await heal(world, item.how, failing('healing', false));
        out.push(...wrong(world, true).map((problem) => `healed: ${problem}`));
        return { problems: out, seen };
      });
    }
    const errorMessage = (error: unknown) =>
      error instanceof Error ? error.message : String(error);

    it('the inventory against the source: every line of I/O of the two files is reached, or listed as not reached with why', () => {
      const realFs = vi.importActual<typeof FsModule>('node:fs');
      return realFs.then((fs) => {
        const lines = (file: string, pattern: RegExp) =>
          fs
            .readFileSync(new URL(`./${file}`, import.meta.url), 'utf8')
            .split('\n')
            .flatMap((text, index) =>
              !/^\s*(\/\/|\*|\/\*)/.test(text) && pattern.test(text) ? [`${file}:${index + 1}`] : []
            );
        const statical = new Set([
          ...lines(
            'pi-adapter.ts',
            /(?<![\w.])(readdirSync|readFileSync|statSync|lstat|readdir|readFile|realpath|rename|rm|writeFile|readPiBashRegistry|readPiProcStat|signalPiBashGroup|readPiPsTable|readPiPsLabelled)\(/
          ),
          ...lines('pi-conversation.ts', /\bfs\.\w+\(/),
        ]);
        const reached = new Set(INVENTORY.map((entry) => entry.split(' ')[0] as string));
        const unreached = new Set(Object.keys(NOT_REACHED));
        expect([...statical].filter((line) => !reached.has(line) && !unreached.has(line))).toEqual(
          []
        );
        expect([...reached, ...unreached].filter((line) => !statical.has(line))).toEqual([]);
        expect([...reached].filter((line) => unreached.has(line))).toEqual([]);
      });
    });

    for (const family of FAMILIES)
      it(`${family.name}: each place failed before, after, partly, once and lasting, then healed`, async () => {
        const { step, healing } = await trace(family);
        const distinct = (hits: Hit[]) => [
          ...new Map(hits.map((hit) => [keyOf(hit), hit])).values(),
        ];
        const keys = distinct(step);
        expect(keys.length).toBeGreaterThan(0);
        for (const hit of step) reach(family, hit, 'step');
        for (const hit of healing) reach(family, hit, 'healing');
        const known = new Set([...step, ...healing].map(keyOf));
        const hows = ['stopSession', 'stopAll', 'start'] as const;
        const failures: string[] = [];
        /**
         * Places only a failure leads to (its handling, its retry), each with what led to it.
         * R7-D: one error path is as many cases as there are failures that lead to it (the place
         * failed and how: a `stat` after a link that was made is not the `stat` after one that
         * was not), not the first case that reached it.
         */
        const errorPaths = new Map<string, { key: string; hit: Seen; by: Case }>();
        let n = 0;
        const check = async (item: Case, label: string) => {
          const { problems, seen } = await runCase(item);
          if (problems.length > 0) failures.push(`${label}: ${problems.join('; ')}`);
          for (const hit of seen) {
            if (known.has(keyOf(hit))) continue;
            const context = `${keyOf(hit)}\n${hit.phase}\n${item.key} ${item.mode}${item.inHealing ? ' in the healing' : ''}`;
            if (!errorPaths.has(context))
              errorPaths.set(context, { key: keyOf(hit), hit, by: item });
          }
        };
        for (const hit of keys)
          for (const mode of modesOf(hit.op))
            for (const lasting of [false, true]) {
              const how = hows[n++ % hows.length] as Case['how'];
              const key = keyOf(hit);
              await check(
                { family, key, op: hit.op, mode, lasting, how },
                `${key} [${mode}${lasting ? ', lasting' : ''}, ${how}]`
              );
            }
        // A place only the healing reaches (the next start, the sweep): failed while it heals.
        for (const hit of distinct(healing).filter(
          (one) => !keys.some((key) => keyOf(key) === keyOf(one))
        ))
          for (const mode of modesOf(hit.op)) {
            const how = hows[n++ % hows.length] as Case['how'];
            await check(
              { family, key: keyOf(hit), op: hit.op, mode, lasting: false, how, inHealing: true },
              `${keyOf(hit)} [${mode}, in the healing, ${how}]`
            );
          }
        // Each error path once more, failed itself, behind the failure that leads to it.
        for (const { key, hit, by } of [...errorPaths.values()]) {
          reach(family, hit, 'error path');
          for (const mode of modesOf(hit.op)) {
            const { problems } = await runCase({ ...by, extra: { key, mode, phase: hit.phase } });
            if (problems.length > 0)
              failures.push(
                `${key} [${mode}, ${hit.phase === 'healing' ? 'while healing ' : ''}behind ${by.key} ${by.mode}${by.inHealing ? ' (in the healing)' : ''}]: ${problems.join('; ')}`
              );
          }
        }
        familiesRun.add(family.name);
        expect(failures).toEqual([]);
      }, 900_000);

    it('the inventory: every place of I/O the families reached is listed (file:line and call), and every one listed was reached', () => {
      // Valid after every family ran (the whole file, or this describe).
      expect([...familiesRun].sort()).toEqual(FAMILIES.map((family) => family.name).sort());
      const out = process.env.PI_IO_INVENTORY_OUT;
      if (out)
        writeFileSync(
          out,
          `${JSON.stringify(
            [...REACHED.entries()]
              .sort(([a], [b]) => (a < b ? -1 : 1))
              .map(([key, { hit, families, paths }]) => ({
                key,
                via: hit.via,
                chain: hit.chain,
                families: [...families],
                paths: [...paths],
              })),
            null,
            1
          )}\n`
        );
      expect([...REACHED.keys()].sort()).toEqual([...INVENTORY].sort());
    });

    /**
     * D-16 (operator's addendum, ~22:00): the random test beside the matrix. Each run: a start,
     * up to three messages, and a stop (`stopSession`, `stopAll`) or Pi going away, at a random
     * moment (a random number of microtasks and turns of the event loop after the start began);
     * one I/O call of the inventory's files, picked at random by its place in the run (the n-th),
     * fails in a mode it can fail in (before, after, partly), once or for as long as it lasts.
     * After it, the oracle of the matrix (`wrong`), while it lasts too, then the failure goes, a
     * random try (`heal`) and nothing may be left. The seed of every run comes from one seed
     * (`PI_FUZZ_SEED`, written in the summary), so a run is drawn again with its own
     * (`PI_FUZZ_ONLY`); what the event loop does between real file system calls is not drawn, so a
     * run drawn again takes the same choices, not always the same interleaving. `PI_FUZZ_RUNS`:
     * how many (1000 by default, the CI run); `PI_FUZZ_OUT`: where the summary goes.
     */
    it('random: start, messages, a stop or Pi going away at a random moment, one I/O call failing at random; the oracle after every run', async () => {
      const runs = Number(process.env.PI_FUZZ_RUNS ?? 1000);
      const seed = Number(process.env.PI_FUZZ_SEED ?? 20_261_104);
      const only = process.env.PI_FUZZ_ONLY ? Number(process.env.PI_FUZZ_ONLY) : null;
      const prng = (from: number) => {
        let value = from >>> 0;
        return () => {
          value = (value + 0x6d2b79f5) >>> 0;
          let mixed = Math.imul(value ^ (value >>> 15), 1 | value);
          mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
          return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
        };
      };
      const draw = prng(seed);
      const stats = {
        runs: 0,
        failed: 0,
        hit: 0,
        lasting: 0,
        byOp: {} as Record<string, number>,
        byStop: {} as Record<string, number>,
      };
      const failures: Array<{ run: number; seed: number; plan: unknown; problems: string[] }> = [];
      const started = Date.now();
      for (let run = 0; run < (only === null ? runs : 1); run += 1) {
        const runSeed = only ?? Math.floor(draw() * 4_294_967_296);
        const r = prng(runSeed);
        const int = (low: number, high: number) => low + Math.floor(r() * (high - low + 1));
        const plan = {
          turns: int(0, 3),
          waits: [int(0, 6), int(0, 6), int(0, 6)],
          stop: (['stopSession', 'stopAll', 'crash'] as const)[int(0, 2)] as
            | 'stopSession'
            | 'stopAll'
            | 'crash',
          // What the stop waits for: microtasks (0), turns of the event loop (1), milliseconds (2).
          steps: Array.from({ length: r() < 0.5 ? int(0, 40) : int(40, 160) }, () => {
            const kind = r();
            return kind < 0.4 ? 0 : kind < 0.85 ? 1 : 2;
          }),
          faultAt: r() < 0.9 ? int(1, 30) : 0,
          mode: r(),
          lasting: r() < 0.3,
          how: (['stopSession', 'stopAll', 'start'] as const)[int(0, 2)] as
            | 'stopSession'
            | 'stopAll'
            | 'start',
        };
        const problems = await inWorld(async (world) => {
          settling();
          let calls = 0;
          let fault: { key: string; mode: Mode } | null = null;
          io.state.on = (call) => {
            calls += 1;
            const key = `${call.chain} ${call.op}`;
            if (fault === null && calls === plan.faultAt) {
              const modes = modesOf(call.op);
              fault = { key, mode: modes[Math.floor(plan.mode * modes.length)] as Mode };
              stats.hit += 1;
              stats.byOp[call.op] = (stats.byOp[call.op] ?? 0) + 1;
              if (plan.lasting) stats.lasting += 1;
              return fault.mode;
            }
            return fault !== null && plan.lasting && key === fault.key ? fault.mode : null;
          };
          stats.byStop[plan.stop] = (stats.byStop[plan.stop] ?? 0) + 1;
          const given = input();
          world.sessionIds.add(given.sessionId);
          const script = (async () => {
            let up = false;
            try {
              const session = await world.made.startSession(given);
              world.ids.add(session.nativeSessionId);
              up = true;
            } catch (error) {
              world.errors.push(String(error));
            }
            for (let t = 0; up && t < plan.turns; t += 1) {
              const turnId = `r${t}`;
              try {
                await world.made.sendTurn({ sessionId: given.sessionId, turnId, text: 'x' });
                world.accepted.push(turnId);
              } catch (error) {
                world.errors.push(String(error));
              }
              for (let i = 0; i < (plan.waits[t] ?? 0); i += 1) await tick();
            }
          })();
          const stopper = (async () => {
            for (const step of plan.steps)
              await (step === 0 ? Promise.resolve() : step === 1 ? tick() : pause(1));
            world.stopAt = promptCount();
            const pi = spawned.at(-1)?.pi;
            if (plan.stop === 'crash' && pi) pi.exit(1, null);
            else if (plan.stop === 'stopAll') await world.made.stopAll();
            else await world.made.stopSession(given.sessionId);
          })();
          const out: string[] = [];
          const ended = await Promise.race([
            Promise.all([script, stopper]).then(() => null),
            pause(10_000).then(() => 'the run did not end in 10 s'),
          ]);
          if (ended) out.push(ended);
          try {
            await quiet(world);
            // Pi went away while nothing was asked of it, or before the session started: the
            // session ends as it ends, and no prompt goes after the end either.
            if (world.made.hasSession(given.sessionId)) {
              world.stopAt = promptCount();
              await world.made.stopSession(given.sessionId);
              await quiet(world);
            }
          } catch (error) {
            out.push(errorMessage(error));
          }
          out.push(...wrong(world, false));
          if (plan.lasting) {
            await world.made.stopAll();
            out.push(...wrong(world, false).map((problem) => `while it lasts: ${problem}`));
          }
          await heal(world, plan.how);
          out.push(...wrong(world, true).map((problem) => `healed: ${problem}`));
          if (out.length > 0 && fault)
            out.unshift(
              `failed: ${(fault as { key: string; mode: Mode }).key} [${(fault as { mode: Mode }).mode}]`
            );
          return out;
        });
        stats.runs += 1;
        if (problems.length > 0) {
          stats.failed += 1;
          failures.push({ run, seed: runSeed, plan, problems });
          if (failures.length >= 5) break;
        }
      }
      const summary = { seed, planned: runs, only, ...stats, ms: Date.now() - started, failures };
      if (process.env.PI_FUZZ_OUT)
        writeFileSync(process.env.PI_FUZZ_OUT, `${JSON.stringify(summary, null, 1)}\n`);
      expect(failures).toEqual([]);
      expect(stats.runs).toBe(only === null ? runs : 1);
      // The failures were drawn: most runs had their failing call (the rest ran without one).
      if (only === null) expect(stats.hit).toBeGreaterThan(runs / 2);
    }, 3_600_000);

    // R7-D: negative controls of the oracle (Codex A09, A10): it says what is wrong when the
    // adapter's bookkeeping says nothing.
    it('the oracle: a clean world has nothing wrong (control)', async () => {
      await inWorld(async (world) => {
        expect(wrong(world, false)).toEqual([]);
        expect(wrong(world, true)).toEqual([]);
      });
    });

    it('the oracle (Codex A09): a live decoy whose launch left no trace is wrong, healed or not', async () => {
      await inWorld(async (world) => {
        const decoy = startStuckPi(join(stateDir(), 'run', 'orphan-decoy', 'config.json'));
        expect(decoyAlive(decoy.pid)).toBe(true);
        expect(wrong(world, false)).toEqual([`decoy(s) ${decoy.pid} alive and nothing keeps them`]);
        expect(wrong(world, true)).toEqual(expect.arrayContaining([`decoys alive: ${decoy.pid}`]));
      });
    });

    it('the oracle (Codex A10): an empty record of cleanup is still a record left', async () => {
      await inWorld(async (world) => {
        mkdirSync(sessionDir(), { recursive: true });
        writeFileSync(
          join(sessionDir(), 'audit-empty.cleanup.json'),
          JSON.stringify({ v: 1, launches: [] })
        );
        expect(wrong(world, true)).toEqual(
          expect.arrayContaining(['record files left: audit-empty.cleanup.json'])
        );
      });
    });
  });
});

// Joint round 3 of stages 2 and 5 (`p1_joint_fix3_brief.md`, D-18 A, D-19 A): the attacks of
// round 7 of both recheck legs (Codex `codex-r7/.../pi-recheck-attack.test.ts` A01–A07, A11, A12;
// Sonnet `sonnet-r7/own-attack*.test.ts` turned into the behaviour expected), and the cost of D-15
// (the groups go before Pi on the `ps` path), measured by flow and by command. Codex A08 (a write
// of the launch's config that fails before the launch is handed to the adapter) is the known limit
// R3-E of stage 4 (`pi-launch.ts`, not this round's), so it is not kept here.
const jointRealFs = await vi.importActual<typeof FsModule>('node:fs');
describe('joint round 3 of stages 2 and 5 (R7-A, R7-B, R7-C; the cost of D-15)', () => {
  const ID = '0199a5c0-0000-7000-8000-0000000003a3';
  const realFs = jointRealFs;
  const eioNow = () => Object.assign(new Error('EIO (test)'), { code: 'EIO' });
  const ledger = (made: InstanceType<typeof PiAdapter>) => internals(made).duties;
  /** A procfs root with only these processes and no `self` (incomplete procfs, R11-C). */
  function partialProc(pids: number[] = [process.pid, process.ppid]) {
    const root = mkdtempSync(join(home, 'proc-partial-'));
    for (const pid of pids) symlinkSync(`/proc/${pid}`, join(root, String(pid)));
    return root;
  }
  /** A `ps` that prints `output` (fixed test literals) and ends with `status`; it notes each run. */
  function fixedPs(output: string, status = 0) {
    const file = join(home, 'ps-fixed');
    writeFileSync(
      file,
      `#!/bin/sh\ntouch '${file}.ran'\nprintf '%s\\n' '${output}'\nexit ${status}\n`,
      { mode: 0o755 }
    );
    return file;
  }

  it('Codex A01 (R7-B): a link made that answered EIO, then its probe EIO: the lock is settled and let go once the failure goes', async () => {
    const made = adapter({ procRoot: partialProc() });
    const given = input();
    let linked = 0;
    let probed = 0;
    io.state.on = (call) => {
      if (call.op === 'linkSync') {
        linked += 1;
        return 'after';
      }
      if (call.op === 'statSync' && call.file.endsWith('.tmp')) {
        probed += 1;
        return 'before';
      }
      return null;
    };
    const result = await made.startSession(given).catch((error: unknown) => error);
    io.state.on = null;
    expect(String(result)).toMatch(/EIO.*cannot be told yet/);
    expect(linked).toBe(1);
    // The probe of the link, and the settling the duty tried while the failure lasted.
    expect(probed).toBeGreaterThanOrEqual(1);
    expect(spawned).toHaveLength(0);
    // While it lasted the lock was kept, with the duty that settles it.
    await made.stopSession(given.sessionId);
    await made.stopAll();
    expect(heldLocks()).toEqual([]);
    expect(ledger(made).size).toBe(0);
    // No temporary file of the lock is left either: it went once the entry was told.
    const locks = readdirSync(sessionDir()).filter((name) => name.endsWith('.lock'));
    for (const lock of locks)
      expect(readdirSync(join(sessionDir(), lock)).filter((name) => name.endsWith('.tmp'))).toEqual(
        []
      );
  });

  // R7-B at its source: the link answered EIO and its probe failed. Two worlds: the link was made
  // (the entry is this attempt's: the temporary file under a second name), or it was not and
  // another taker made `<n>` meanwhile (also this process, for another session).
  it.each([
    ['made: the entry is let go once it can be told', true],
    ['not made, another took the entry: it is never let go', false],
  ])('R7-B: a link whose making cannot be told (%s)', (_name, made) => {
    const dir = mkdtempSync(join(home, 'sessions-'));
    const lockDir = join(dir, `${ID}.lock`);
    let probeFails = true;
    const failing = {
      ...realFs,
      linkSync: ((from: string, to: string) => {
        if (made) realFs.linkSync(from, to);
        else
          realFs.writeFileSync(to, JSON.stringify({ v: 1, pid: process.pid, start: hostStart() }));
        throw eioNow();
      }) as typeof realFs.linkSync,
      statSync: ((file: string, ...rest: unknown[]) => {
        if (probeFails && String(file).endsWith('.tmp')) throw eioNow();
        return (realFs.statSync as (...args: unknown[]) => unknown)(file, ...rest);
      }) as typeof realFs.statSync,
    } as typeof realFs;
    const held = piConversationStore({ fs: failing, procRoot: '/proc' }).lock(dir, ID);
    expect(held).toMatchObject({ failed: expect.stringMatching(/cannot be told yet/) });
    if (!('failed' in held)) throw new Error('not failed');
    // The evidence stays while it cannot be told: the temporary file is kept.
    expect(readdirSync(lockDir).filter((name) => name.endsWith('.tmp'))).toHaveLength(1);
    // The probe still fails: the release throws (the duty tries again), nothing is let go.
    expect(() => held.release()).toThrow(/EIO/);
    expect(realFs.existsSync(join(lockDir, '1.released'))).toBe(false);
    probeFails = false;
    held.release();
    expect(realFs.existsSync(join(lockDir, '1.released'))).toBe(made);
    expect(readdirSync(lockDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // Once done, done: a second call changes nothing.
    held.release();
    expect(readdirSync(lockDir).sort()).toEqual(made ? ['1.owner', '1.released'] : ['1.owner']);
  });

  it('Codex A02 (control): a link made that answered EIO alone is the session’s and is let go', async () => {
    const made = adapter({ procRoot: partialProc() });
    const given = input();
    let hit = 0;
    io.state.on = (call) => (call.op === 'linkSync' && ++hit === 1 ? 'after' : null);
    await made.startSession(given).catch(() => undefined);
    io.state.on = null;
    await made.stopSession(given.sessionId);
    expect(hit).toBe(1);
    expect(heldLocks()).toEqual([]);
    expect(ledger(made).size).toBe(0);
  });

  it('Codex A03 (R7-A): a malformed ps start never makes a live holder’s lock free', () => {
    const proc = join(home, 'empty-proc');
    mkdirSync(proc);
    mkdirSync(sessionDir(), { recursive: true });
    const ps = fixedPs('S Wed Nov 4 12:00:00 2026');
    const store = piConversationStore({ fs: realFs, procRoot: proc, ps });
    expect('owner' in store.lock(sessionDir(), 'ps-live')).toBe(true);
    for (const output of ['S unavailable', 'S Wed Nov 4', 'Q Wed Nov 4 12:00:00 2026', 'S'])
      expect(
        piConversationStore({ fs: realFs, procRoot: proc, ps: fixedPs(output) }).lock(
          sessionDir(),
          'ps-live'
        ),
        output
      ).toHaveProperty('busy');
    // A recorded start read from a whole answer and another one now: the holder is gone.
    const other = piConversationStore({
      fs: realFs,
      procRoot: proc,
      ps: fixedPs('S Thu Nov 5 01:00:00 2026'),
    });
    expect(other.stillRuns(process.pid, 'ps:Wed Nov 4 12:00:00 2026')).toBe(false);
    // A malformed recorded start of a PID that lives tells nothing: taken to run.
    expect(other.stillRuns(process.pid, 'ps:unavailable')).toBe(true);
    // Its own identity from a malformed answer is unknown, so the start is refused (R4-A).
    expect(
      piConversationStore({
        fs: realFs,
        procRoot: proc,
        ps: fixedPs('S unavailable'),
      }).ownIdentity().start
    ).toBeNull();
  });

  it('Codex A04 (R7-C): a root with processes but no self is procfs for the store as for pi-bash', () => {
    const proc = partialProc();
    const ps = fixedPs('S Wed Nov 4 12:00:00 2026');
    expect(piBashProcessView({ procRoot: proc, ps })).toBe('procfs');
    const wanted = readPiProcStat(process.pid, { procRoot: proc })?.starttime;
    expect(
      piConversationStore({ fs: realFs, procRoot: proc, ps }).processStart(process.pid)?.start
    ).toBe(wanted);
    expect(existsSync(`${ps}.ran`)).toBe(false);
  });

  it('Codex A05 (R7-C): a root with processes but no self: the adapter confirms a gone marked intent', async () => {
    const proc = partialProc();
    const ps = fixedPs(
      `${process.pid} ${process.ppid} ${process.pid} ${process.getuid!()} S Wed Nov 4 12:00:00 2026`
    );
    const registry = join(home, 'intent.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, event: 'intent', instance: 'audit', toolCallId: 'gone', run: 1, marker: 'audit-gone-unique' })}\n`
    );
    const result = await killPiBashGroups(registry, () => true, {
      procRoot: proc,
      ps,
      timeoutMs: 0,
      includeUnspawned: true,
    });
    expect(result.confirmed).toBe(true);
  });

  it('Codex A06 (control): without procfs an intent with no label is never confirmed', async () => {
    const proc = join(home, 'empty-proc');
    mkdirSync(proc);
    const ps = fixedPs(
      `${process.pid} ${process.ppid} ${process.pid} ${process.getuid!()} S Wed Nov 4 12:00:00 2026`
    );
    const registry = join(home, 'intent.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, event: 'intent', instance: 'audit', toolCallId: 'unknown', run: 1, marker: 'audit-unknown' })}\n`
    );
    const result = await killPiBashGroups(registry, () => true, {
      procRoot: proc,
      ps,
      timeoutMs: 0,
      includeUnspawned: true,
    });
    expect(result.confirmed).toBe(false);
    expect(result.unconfirmed.join(' ')).toContain('markers');
  });

  it('Codex A11 (R7-C): with processes but no self, a ps that sees nothing never overrides a live holder procfs shows', () => {
    const proc = partialProc();
    mkdirSync(sessionDir(), { recursive: true });
    const store = piConversationStore({
      fs: realFs,
      procRoot: proc,
      ps: fixedPs('S Wed Nov 4 12:00:00 2026'),
    });
    expect('owner' in store.lock(sessionDir(), 'partial-proc-live')).toBe(true);
    const blind = piConversationStore({ fs: realFs, procRoot: proc, ps: fixedPs('', 1) });
    expect(blind.lock(sessionDir(), 'partial-proc-live')).toHaveProperty('busy');
  });

  it('Codex A12 (R7-C): an empty root someone passed without ps confirms no unseen marker', async () => {
    const proc = join(home, 'empty-custom-proc');
    mkdirSync(proc);
    const registry = join(home, 'intent-empty-root.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, event: 'intent', instance: 'audit', toolCallId: 'unseen', run: 1, marker: 'audit-unseen' })}\n`
    );
    const result = await killPiBashGroups(registry, () => true, {
      procRoot: proc,
      timeoutMs: 0,
      includeUnspawned: true,
    });
    expect(result.confirmed).toBe(false);
    // Nor a group: the table of an empty root is not an empty table.
    const group = startGroup('sleep 60', 'm-empty-root');
    const groups = join(home, 'group-empty-root.jsonl');
    register(groups, group, { toolCallId: 'g', run: 1, marker: 'm-empty-root' });
    const seen = await killPiBashGroups(groups, () => true, { procRoot: proc, timeoutMs: 0 });
    expect(seen.confirmed).toBe(false);
    expect(seen.unconfirmed.join('; ')).toMatch(/process table could not be read/);
    expect(liveMembers(group.pid)).toBeGreaterThan(0);
  });

  it('Sonnet S5-OWN-A (R7-C): the store reads a root with a process but no self as procfs, as pi-bash does', () => {
    const root = mkdtempSync(join(home, 'partial-'));
    mkdirSync(join(root, '4242'));
    const ps = fixedPs('S Wed Nov 4 09:10:58 2026');
    expect(piBashProcessView({ procRoot: root, ps })).toBe('procfs');
    const store = piConversationStore({ fs: realFs, procRoot: root, ps });
    // Procfs: this process is not in that root, so its start is unknown, never `ps:` from `ps`.
    expect(store.ownIdentity().start).toBeNull();
    expect(existsSync(`${ps}.ran`)).toBe(false);
  });

  it('Sonnet S5-OWN-B (R7-C): a live group in a root with processes but no self is verified and killed there', async () => {
    const group = startGroup('sleep 60', 'm-partial');
    const root = partialProc([process.pid, group.pid]);
    const registry = join(home, 'partial.jsonl');
    register(registry, group, { toolCallId: 'c1', run: 1, marker: 'm-partial' });
    const result = await killPiBashGroups(registry, () => true, {
      includeUnspawned: true,
      procRoot: root,
      ps: 'ps',
      timeoutMs: 600,
      since: hostStart(),
    });
    expect(result).toMatchObject({ confirmed: true, killed: 1 });
    expect(liveMembers(group.pid)).toBe(0);
  });

  // D-18: without procfs the label finds a shell recorded only as intended, and what carries a label
  // is counted, never signalled (a label is visible to anyone in the process list).
  it('D-18: without procfs a process carrying a shell’s label is counted and left alone', async () => {
    const label = labelFor();
    const decoy = realChild.spawn('/bin/sh', ['-c', 'sleep 60; true', 'sh', label], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin' },
    });
    decoy.unref();
    groups.push(decoy.pid as number);
    await until(() => {
      try {
        return readPiPsCommand(decoy.pid as number).args.includes(label);
      } catch {
        return false;
      }
    }, 'decoy');
    const registry = join(home, 'labelled.jsonl');
    const record = { v: 1, instance: 'i-1', toolCallId: 'c1', run: 1, marker: 'i-1:c1', label };
    writeFileSync(registry, `${JSON.stringify({ ...record, event: 'intent' })}\n`);
    const result = await killPiBashGroups(registry, () => true, {
      ...hiddenView(),
      includeUnspawned: true,
      timeoutMs: 200,
    });
    expect(result.confirmed).toBe(false);
    expect(result.unconfirmed).toContain('1 labelled process(es) left');
    expect(decoyAlive(decoy.pid as number)).toBe(true);
    // Gone, it is gone for the label too.
    process.kill(-(decoy.pid as number), 'SIGKILL');
    await until(() => !decoyAlive(decoy.pid as number), 'decoy gone');
    expect(
      await killPiBashGroups(registry, () => true, {
        ...hiddenView(),
        includeUnspawned: true,
        timeoutMs: 200,
      })
    ).toEqual({ confirmed: true, killed: 0, unconfirmed: [] });
  });

  // ---------------------------------------------------------------------------------------------
  // The cost of D-15 (brief 2.5): a stand-in for Pi's bridge, a live parent that started a shell as
  // the bridge starts one (its own session and group, the marker in its environment, its label in
  // its command line), recorded as the bridge records it; the parent dies when the adapter stops
  // the FakePi (Pi going away takes the bridge with it).

  /** `lstart` of a process as the bridge reads it without procfs. */
  const lstartOf = (pid: number) => {
    const result = realChild.spawnSync('ps', ['-ww', '-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' },
    });
    const text = result.stdout.trim().replace(/\s+/g, ' ');
    return result.status === 0 && text !== '' ? text : undefined;
  };
  const labelFor = () =>
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  interface Shell {
    parent: number;
    shell: number;
    label: string;
    escapee?: number;
  }
  /**
   * Starts `command` under a stand-in bridge and records it in `registry` as the bridge would
   * (intent, spawn, the starts and, while it carries its label, the digest of its command line);
   * the stand-in writes `exit` when the shell ends, as the bridge does.
   */
  async function bridged(
    registry: string,
    command: string,
    toolCallId: string,
    run = 1
  ): Promise<Shell> {
    const label = labelFor();
    const tag = `${toolCallId}-${label.slice(0, 8)}`;
    const pidFile = join(home, `${tag}.pid`);
    const gate = join(home, `${tag}.gate`);
    const marker = tagged(`i-1:${toolCallId}`);
    const script = [
      `setsid /bin/bash -c "$1" /bin/bash "$2" & child=$!`,
      `echo "$child" > '${pidFile}'`,
      'wait "$child"',
      `while [ ! -f '${gate}' ]; do sleep 0.01; done`,
      `printf '{"v":1,"instance":"i-1","toolCallId":"%s","event":"exit","pid":%s}\\n' '${toolCallId}' "$child" >> '${registry}'`,
      'exec sleep 600',
    ].join('\n');
    const parent = realChild.spawn('/bin/sh', ['-c', script, 'sh', command, label], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', SWITCH_PI_TC: marker },
    });
    parent.unref();
    groups.push(parent.pid as number);
    await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'shell');
    const shell = Number(readFileSync(pidFile, 'utf8'));
    groups.push(shell);
    await until(() => readPiProcStat(shell)?.pgrp === shell || !readPiProcStat(shell), 'setsid');
    const argv = ['/bin/bash', '-c', command, '/bin/bash', label];
    const base = { v: 1, instance: 'i-1', toolCallId, run, marker };
    const lines = [
      { ...base, event: 'intent', label },
      {
        ...base,
        event: 'spawn',
        pid: shell,
        pgid: shell,
        starttime: readPiProcStat(shell)?.starttime ?? null,
        ppid: parent.pid,
        args: piBashArgsFingerprint(argv),
        label,
      },
    ];
    const lstart = lstartOf(shell);
    const plstart = lstartOf(parent.pid as number);
    let cmd: string | undefined;
    try {
      const seen = readPiPsCommand(shell).args;
      if (seen.split(/\s+/).includes(label)) cmd = piBashPsArgsDigest(seen);
    } catch {
      cmd = undefined;
    }
    if (lstart && plstart)
      lines.push({
        ...base,
        event: 'lstart',
        pid: shell,
        lstart,
        plstart,
        ...(cmd === undefined ? {} : { cmd }),
      } as never);
    writeFileSync(registry, lines.map((line) => `${JSON.stringify(line)}\n`).join(''), {
      flag: 'a',
    });
    writeFileSync(gate, '');
    return { parent: parent.pid as number, shell, label };
  }
  /** Pi going away takes its bridge with it: the stand-in parent dies with the FakePi. */
  function tieToPi(pi: FakePi, parent: number): { gone: boolean } {
    const state = { gone: false };
    const exit = pi.exit.bind(pi);
    pi.exit = ((...args: Parameters<FakePi['exit']>) => {
      state.gone = true;
      try {
        process.kill(parent, 'SIGKILL');
      } catch {
        // gone
      }
      return exit(...args);
    }) as FakePi['exit'];
    return state;
  }
  const hiddenView = () => ({ procRoot: join(home, 'no-proc'), ps: 'ps' });
  const flowsOut: unknown[] = [];
  afterAll(() => {
    const out = process.env.PI_FLOWS_OUT;
    if (out) realFs.writeFileSync(out, `${JSON.stringify(flowsOut, null, 1)}\n`);
  });

  type Flow = 'stopSession' | 'stopAll' | 'turn stop (retire)' | 'interrupt' | 'Pi goes away';
  /** One flow with one command under the stand-in bridge: what is left, and is it said. */
  async function flow(view: 'procfs' | 'ps', how: Flow, command: string) {
    events.length = 0;
    const made = adapter({
      ...(view === 'ps' ? hiddenView() : {}),
      cleanupTimeoutMs: 600,
      interruptTimeoutMs: 100,
    });
    const { given, entry } = await started(made);
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const shell = await bridged(registry, command, 'c1');
    const pi = tieToPi(entry.pi, shell.parent);
    // `setsid sleep` of the command, if it started one: its own session, outside the group.
    await pause(150);
    if (how === 'stopSession') await made.stopSession(given.sessionId);
    else if (how === 'stopAll') await made.stopAll();
    else if (how === 'interrupt') {
      await made.interruptTurn(given.sessionId);
      settle(entry.pi, true);
      await until(() => completed('t').length === 1, 'turn');
      await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready', 4000);
    } else if (how === 'turn stop (retire)') {
      await made.interruptTurn(given.sessionId);
      await until(() => completed('t').length === 1, 'turn', 4000);
      await until(() => pi.gone, 'Pi retired', 4000);
      // The check after Pi (`kill`, up to the cleanup timeout) ends the retirement: the shell is
      // gone, or a warning says it could not be confirmed.
      await until(
        () => /could not confirm/.test(warnings()) || !shellLives(shell),
        'retired',
        4000
      );
      await pause(700);
    } else {
      entry.pi.exit(1, null);
      await until(() => of('session.exited').length === 1, 'exited', 8000);
    }
    const unconfirmed = /could not confirm|cannot confirm/.test(warnings());
    const left = [...new Set([shell.shell, ...pgroupMembers(shell.shell)])].filter(decoyAlive);
    const escapees = escapeesOf(shell.label, command);
    const record = recordFiles().length > 0;
    flowsOut.push({ view, how, command, unconfirmed, record, left: left.length, escapees });
    // Whatever stays, the test's own cleanup kills it.
    if (made.hasSession(given.sessionId)) await made.stopSession(given.sessionId);
    return { unconfirmed, left: left.length, record, escapees };
  }
  const shellLives = (shell: Shell) =>
    decoyAlive(shell.shell) || pgroupMembers(shell.shell).length > 0;
  /** Live members of a group (the system's procfs). */
  function pgroupMembers(pgid: number): number[] {
    const out: number[] = [];
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      const stat = readPiProcStat(Number(name));
      if (stat && stat.pgrp === pgid && stat.state !== 'Z') out.push(Number(name));
    }
    return out;
  }
  /** Processes that left the group by `setsid` (this test's own: they carry its marker). */
  function escapeesOf(_label: string, command: string): number {
    if (!command.startsWith('setsid')) return 0;
    let count = 0;
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue;
      try {
        const environ = readFileSync(`/proc/${name}/environ`);
        if (
          environ.includes(Buffer.from(`SWITCH_PI_TC=${tagged('i-1:c1')}\0`)) &&
          decoyAlive(Number(name))
        ) {
          const stat = readPiProcStat(Number(name));
          if (stat && stat.sid === Number(name)) {
            groups.push(Number(name));
            count += 1;
          }
        }
      } catch {
        // not readable: not this test's
      }
    }
    return count;
  }
  const warnings = () => allWarnings();

  // Brief 2.5: the flows × procfs and `ps`, with `sleep 30; true` (P03: bash stays the leader).
  it.each([
    ['procfs', 'stopSession', false],
    ['procfs', 'stopAll', false],
    ['procfs', 'turn stop (retire)', false],
    ['procfs', 'interrupt', false],
    ['procfs', 'Pi goes away', false],
    ['ps', 'stopSession', false],
    ['ps', 'stopAll', false],
    ['ps', 'turn stop (retire)', false],
    ['ps', 'interrupt', false],
    // Known limit: Pi died before anything could verify its shells (no procfs): unconfirmed.
    ['ps', 'Pi goes away', true],
  ] as const)(
    'D-15 cost, flow on %s: %s',
    async (view, how, unconfirmedExpected) => {
      const result = await flow(view, how, 'sleep 30; true');
      expect(result.unconfirmed).toBe(unconfirmedExpected);
      // What is not confirmed at the end of a session is recorded (it blocks the resume).
      expect(result.record).toBe(unconfirmedExpected);
      if (!unconfirmedExpected) expect(result.left).toBe(0);
    },
    20_000
  );

  // Brief 2.5: a stop of the session × the commands of Codex's measurement (P01–P06) and a
  // command whose child leaves the group (`setsid`), procfs and `ps`.
  it.each([
    ['procfs', 'P01', 'sleep 30', false, 0],
    ['procfs', 'P02', 'true; sleep 30', false, 0],
    ['procfs', 'P03', 'sleep 30; true', false, 0],
    ['procfs', 'P04', 'sleep 30 | cat', false, 0],
    ['procfs', 'P05', 'sleep 30 & wait', false, 0],
    ['procfs', 'P06', 'sleep 30 & exit 0', false, 0],
    ['procfs', 'setsid', 'setsid sleep 30 & sleep 30; true', false, 0],
    // `exec` (bash runs the last command in its place): the label is gone, nothing is verified.
    ['ps', 'P01', 'sleep 30', true, 1],
    ['ps', 'P02', 'true; sleep 30', true, 1],
    ['ps', 'P03', 'sleep 30; true', false, 0],
    ['ps', 'P04', 'sleep 30 | cat', false, 0],
    ['ps', 'P05', 'sleep 30 & wait', false, 0],
    // The shell ended, a job of it lives: no member can be verified without procfs.
    ['ps', 'P06', 'sleep 30 & exit 0', true, 1],
    // Known limit: what left the group by `setsid` carries no label; nothing finds it.
    ['ps', 'setsid', 'setsid sleep 30 & sleep 30; true', false, 0],
  ] as const)(
    'D-15 cost, stop of the session on %s, %s (%s)',
    async (view, _id, command, unconfirmedExpected, left) => {
      const result = await flow(view, 'stopSession', command);
      expect(result.unconfirmed).toBe(unconfirmedExpected);
      expect(result.record).toBe(unconfirmedExpected);
      expect(result.left).toBe(left);
      // procfs finds the escapee by its marker and kills it; the `ps` path does not see it.
      if (command.startsWith('setsid')) expect(result.escapees).toBe(view === 'ps' ? 1 : 0);
    },
    20_000
  );

  // ---------------------------------------------------------------------------------------------
  // Joint round 4 of stages 2 and 5 (FAP: U-1, U-4, U-5, U-8; RAPKGE-01…03).

  /** Everything Switch said: turn ends, warnings, the end of sessions. */
  const said = () =>
    events
      .flatMap((event) =>
        event.type === 'turn.completed'
          ? [event.message ?? '']
          : event.type === 'runtime.warning'
            ? [event.message]
            : event.type === 'session.exited'
              ? [event.reason]
              : []
      )
      .join('\n');
  /** D-23 C: a claim that Switch (or the interrupt) stopped something. */
  const CLAIM = /\b(?:Switch|the interrupt) stopped\b/;

  it('U-4 (D-23 C, Codex FAP-A03): a forced interrupt whose Pi cannot be confirmed gone never says it was stopped', async () => {
    events.length = 0;
    const made = adapter({ interruptTimeoutMs: 50 });
    const { given, entry } = await started(made);
    const stuck = startStuckPi(entry.options.env!.SWITCH_PI_BRIDGE as string);
    vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
      new Error('Provider process did not exit after termination.')
    );
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    await made.interruptTurn(given.sessionId);
    await until(() => completed('t').length === 1, 'interrupted turn', 4000);
    await until(() => /could not confirm/.test(warnings()), 'warning', 4000);
    expect(liveMembers(stuck.pid)).toBeGreaterThan(0);
    expect(completed('t')[0]?.message).toMatch(/so Switch stops it; a warning follows/);
    expect(warnings()).toMatch(/Switch tried to stop Pi and could not confirm that it exited/);
    expect(warnings()).toMatch(/Pi did not exit when Switch tried to stop it/);
    expect(said()).not.toMatch(CLAIM);
  });

  it('U-4 (D-23 C): a run the bridge did not announce: Switch says it asked Pi to stop it', async () => {
    events.length = 0;
    const { made, given, entry } = await started();
    entry.pi.handlers.set('prompt', () => ({ data: { disposition: 'started' } }));
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => completed('t').length === 1, 'turn');
    expect(completed('t')[0]?.message).toMatch(/did not announce, so Switch asked Pi to stop it/);
    expect(said()).not.toMatch(CLAIM);
  });

  it('U-4 (D-23 C): Pi that dies mid-command: the end says Switch stops what the command left, and warns when it cannot confirm it', async () => {
    events.length = 0;
    const made = adapter(hiddenView());
    const { given, entry } = await started(made);
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    toolStart(entry.pi, 'call-big', 'bash', { command: 'seq 1 100000; sleep 12' });
    // Without procfs a group recorded without its starts cannot be verified: unconfirmed.
    const orphan = startGroup('sleep 60', 'm-u4');
    register(registry, orphan, { toolCallId: 'call-big', run: 1, marker: 'm-u4' });
    entry.pi.exit(1, null);
    await until(() => of('session.exited').length === 1, 'exit', 8000);
    expect(completed('t')[0]?.message).toMatch(
      /Switch stops the processes the command left, and warns if that cannot be confirmed/
    );
    expect(warnings()).toMatch(/could not confirm that every process of this Pi session stopped/);
    expect(said()).not.toMatch(CLAIM);
  });

  it.each([
    ['confirmed', false],
    ['not confirmed', true],
  ] as const)(
    'U-4 (D-23 C): what earlier runs left is reported with the current run’s cleanup %s',
    async (_name, unconfirmed) => {
      events.length = 0;
      const made = adapter({ cleanupTimeoutMs: 300 });
      const { given, entry } = await started(made);
      const registry = entry.config!.processRegistry;
      await made.sendTurn({ sessionId: given.sessionId, turnId: 'first', text: 'a' });
      await until(() => prompts(entry.pi).length === 1, 'first prompt');
      entry.pi.emitRecords(fakePiTextTurn('a', 'one'));
      await until(() => completed('first').length === 1, 'first turn');
      await made.sendTurn({ sessionId: given.sessionId, turnId: 'second', text: 'b' });
      await until(() => prompts(entry.pi).length === 2, 'second prompt');
      const earlier = startGroup('sleep 60', 'i-1:u4-old');
      const current = startGroup('sleep 60', 'i-1:u4-now');
      register(registry, earlier, { toolCallId: 'old', run: 1, marker: 'i-1:u4-old' });
      // Not confirmed: the current run's shell only as intended, with a marker none carries, and
      // the markers unreadable (a procfs whose environ reads fail) keep it unconfirmed.
      if (unconfirmed)
        fsFaults.read = (file) => (/^\/proc\/\d+\/environ$/.test(file) ? 'EIO' : null);
      register(registry, current, { toolCallId: 'now', run: 2, marker: 'i-1:u4-now' });
      await made.interruptTurn(given.sessionId);
      settle(entry.pi, true);
      await until(() => completed('second').length === 1, 'second turn');
      await until(() => /still run in the background/.test(warnings()), 'report', 4000);
      fsFaults.read = null;
      const report = warnings();
      if (unconfirmed) {
        expect(report).toMatch(
          /could not confirm that the commands of the interrupted run stopped/
        );
        expect(report).toMatch(
          /Switch tried to stop only the commands of the current run, and could not confirm that they are gone/
        );
      } else {
        expect(liveMembers(current.pid)).toBe(0);
        expect(report).toMatch(/only the commands of the current run were stopped/);
      }
      expect(said()).not.toMatch(CLAIM);
    },
    20_000
  );

  // RAPKGE-02: `!interrupt` × a plain `sleep 30` (P01: bash gives its place to `sleep`, so the
  // label of D-18 is gone) on the `ps` path. Pi 1.4.0 aborts the running tool on RPC `abort`, and
  // the bridge kills the shell's group then (`bridge.ts` `onAbort`; probe U-6, real Pi, both
  // paths): the stand-in models that when `model` is set; FakePi alone does not (it ignores the
  // abort), which is what the measurement of joint round 3 measured.
  it.each([
    ['as Pi 1.4.0 (the bridge kills the group on abort)', true, false],
    ['as FakePi alone (nothing kills it)', false, true],
  ] as const)(
    'RAPKGE-02 (ps, P01): an interrupt of `sleep 30` %s',
    async (_name, model, unconfirmedExpected) => {
      events.length = 0;
      const made = adapter({ ...hiddenView(), cleanupTimeoutMs: 600, interruptTimeoutMs: 2000 });
      const { given, entry } = await started(made);
      const registry = entry.config!.processRegistry;
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
      await until(() => prompts(entry.pi).length === 1, 'prompt');
      const shell = await bridged(registry, 'sleep 30', 'c1');
      tieToPi(entry.pi, shell.parent);
      await pause(150);
      if (model)
        entry.pi.handlers.set('abort', () => {
          try {
            process.kill(-shell.shell, 'SIGKILL');
          } catch {
            // gone
          }
          return { data: undefined };
        });
      await made.interruptTurn(given.sessionId);
      await until(() => !model || !shellLives(shell), 'the abort killed the group', 4000);
      settle(entry.pi, true);
      await until(() => completed('t').length === 1, 'turn');
      // The cleanup's result: the session ready again, or blocked with the warning that says why.
      await until(
        () =>
          of('session.state.changed').at(-1)?.status === 'ready' ||
          /could not confirm|cannot confirm/.test(warnings()),
        'the cleanup’s result',
        4000
      );
      const unconfirmed = /could not confirm|cannot confirm/.test(warnings());
      flowsOut.push({ id: 'RAPKGE-02', model, unconfirmed, alive: shellLives(shell) });
      expect(unconfirmed).toBe(unconfirmedExpected);
      expect(shellLives(shell)).toBe(!model);
      expect(said()).not.toMatch(CLAIM);
    },
    20_000
  );

  // RAPKGE-01 (= FAP-01, Opus FAP-A1/A1b, Codex A01): without procfs, a stop that saw Pi exit and
  // could not confirm a plain command records Pi's exit (O-1 A, `piExited`). Joint round 4 pinned
  // the known limit (the next start refused: "Pi: its exit cannot be confirmed"); joint round 5:
  // once the command ended by itself, the next start, in this adapter or a later one, resumes.
  /** A stop on the `ps` path that leaves a plain command running; `stuck`: Pi's exit not seen. */
  async function stopLeavingCommand(stuck: boolean) {
    events.length = 0;
    const made = adapter({ ...hiddenView(), cleanupTimeoutMs: 600, interruptTimeoutMs: 100 });
    const { given, entry, session } = await started(made);
    const registry = entry.config!.processRegistry;
    await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
    await until(() => prompts(entry.pi).length === 1, 'prompt');
    const shell = await bridged(registry, 'sleep 4', 'c1');
    tieToPi(entry.pi, shell.parent);
    await pause(150);
    if (stuck)
      vi.spyOn(PiRpcClient.prototype, 'dispose').mockRejectedValue(
        new Error('Provider process did not exit after termination.')
      );
    await made.stopSession(given.sessionId);
    vi.restoreAllMocks();
    expect(/could not confirm|cannot confirm/.test(warnings())).toBe(true);
    expect(recordFiles()).toHaveLength(1);
    const record = JSON.parse(
      readFileSync(join(sessionDir(), recordFiles()[0] as string), 'utf8')
    ) as { launches: Array<Record<string, unknown>> };
    return { made, given, entry, session, shell, registry, record };
  }
  const resumeIn = (next: InstanceType<typeof PiAdapter>, id: string) =>
    next.startSession(input({ resume: { nativeSessionId: id } })).then(
      () => 'started',
      (error: unknown) => String(error)
    );
  it.each([
    ['the same adapter', false],
    ['a later adapter', true],
  ] as const)(
    'RAPKGE-01 (ps, P01, O-1 A): after the command ended by itself, %s resumes the conversation',
    async (_name, later) => {
      const { made, given, session, shell, record } = await stopLeavingCommand(false);
      expect(record.launches).toHaveLength(1);
      expect(record.launches[0]).toMatchObject({ piExited: true });
      expect(record.launches[0]?.ended).toBeUndefined();
      // While the command lives, the record still refuses (its groups, not its Pi).
      writeTranscript(session.nativeSessionId, given.cwd);
      const early = await resumeIn(
        later ? adapter({ ...hiddenView() }) : made,
        session.nativeSessionId
      );
      expect(early).toMatch(
        /could not confirm that the processes this Pi conversation started before/
      );
      expect(early).not.toMatch(/Pi: its exit cannot be confirmed/);
      await until(() => !shellLives(shell), 'the command ended by itself', 10_000);
      const next = later ? adapter({ ...hiddenView(), cleanupTimeoutMs: 600 }) : made;
      const outcome = await resumeIn(next, session.nativeSessionId);
      flowsOut.push({ id: 'RAPKGE-01', later, outcome: outcome.slice(0, 200) });
      expect(outcome).toBe('started');
      expect(recordFiles()).toHaveLength(0);
    },
    30_000
  );

  it('RAPKGE-01 negative (ps, O-1 A): a stop that did not see Pi exit records no proof, and the next start still refuses once the command ended', async () => {
    const { session, given, shell, record } = await stopLeavingCommand(true);
    expect(record.launches[0]?.piExited).toBeUndefined();
    await until(() => !shellLives(shell), 'the command ended by itself', 10_000);
    writeTranscript(session.nativeSessionId, given.cwd);
    const outcome = await resumeIn(
      adapter({ ...hiddenView(), cleanupTimeoutMs: 300 }),
      session.nativeSessionId
    );
    expect(outcome).toMatch(/Pi: its exit cannot be confirmed/);
    expect(recordFiles()).toHaveLength(1);
  }, 30_000);

  it('O-1 A (ps): a Switch that died after its stop recorded Pi’s exit: the sweep of the next start reads the record before it looks for Pi, and resumes once the command ended', async () => {
    const { session, given, shell, record } = await stopLeavingCommand(false);
    const launch = record.launches[0] as { runDir: string; owner: { pid: number; start: string } };
    // The host that made the launch is gone: a real process that ran and was killed (its PID is
    // free, its start was read while it ran); the launch's owner and the record name it.
    const host = realChild.spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
    host.unref();
    const psStore = piConversationStore(hiddenView());
    await until(() => psStore.processStart(host.pid as number) !== null, 'host');
    const start = psStore.processStart(host.pid as number)?.start as string;
    expect(start).toMatch(/^ps:/);
    process.kill(host.pid as number, 'SIGKILL');
    await until(() => psStore.processStart(host.pid as number) === null, 'host gone');
    const owner = JSON.parse(readFileSync(join(launch.runDir, 'owner.json'), 'utf8')) as object;
    writeFileSync(
      join(launch.runDir, 'owner.json'),
      JSON.stringify({ ...owner, pid: host.pid, start })
    );
    const file = join(sessionDir(), `${session.nativeSessionId}.cleanup.json`);
    writeFileSync(
      file,
      `${JSON.stringify({ v: 1, launches: [{ ...launch, owner: { pid: host.pid, start } }] })}\n`
    );
    await until(() => !shellLives(shell), 'the command ended by itself', 10_000);
    writeTranscript(session.nativeSessionId, given.cwd);
    const outcome = await resumeIn(
      adapter({ ...hiddenView(), cleanupTimeoutMs: 300 }),
      session.nativeSessionId
    );
    expect(outcome).toBe('started');
    expect(recordFiles()).toHaveLength(0);
    expect(existsSync(launch.runDir)).toBe(false);
  }, 30_000);

  // U-1 (FAP-02; Opus FAP-A3c, Fable F1-02): the store reads `lstart` in UTC like the bridge and the
  // checks: a change of the system's time zone (here a `ps` that takes the zone from a file unless
  // `TZ` is set, as libc does with `/etc/localtime`) leaves a live session live.
  it.each([
    ['control: the zone stays', 'UTC'],
    ['the zone changes', 'Asia/Tokyo'],
  ])(
    'U-1 (ps, %s): the next start in the same host leaves the live session’s command alone',
    async (_name, zone) => {
      const tzFile = join(home, 'tz');
      writeFileSync(tzFile, 'UTC');
      const ps = join(home, 'ps-tz');
      writeFileSync(
        ps,
        `#!/bin/sh\nif [ -z "$TZ" ]; then TZ=$(cat '${tzFile}'); export TZ; fi\nexec ps "$@"\n`,
        { mode: 0o755 }
      );
      events.length = 0;
      const made = adapter({ procRoot: join(home, 'no-proc'), ps, cleanupTimeoutMs: 600 });
      const { given, entry } = await started(made);
      const registry = entry.config!.processRegistry;
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
      await until(() => prompts(entry.pi).length === 1, 'prompt');
      const shell = await bridged(registry, 'sleep 30; true', 'c1');
      tieToPi(entry.pi, shell.parent);
      await pause(150);
      expect(shellLives(shell)).toBe(true);
      writeFileSync(tzFile, zone);
      const other = await made.startSession(input()).then(
        () => 'started',
        (error: unknown) => String(error)
      );
      await pause(300);
      expect(other).toBe('started');
      expect(shellLives(shell)).toBe(true);
      expect(made.hasSession(given.sessionId)).toBe(true);
    },
    30_000
  );

  // U-8 (FAP-10): another run of this file (another `vitest` at once) tags its markers with its
  // own tag: the adapter of this run neither counts nor kills its decoys, and the `setsid` test
  // does not take them for its escapees. A decoy carrying this run's marker is the control.
  it('U-8 (FAP-10): a decoy of another run, with the same marker under its own tag, is neither found nor killed', async () => {
    const otherRun = (marker: string) => tagged(marker).replace(RUN_TAG, 'another-run');
    const other = realChild.spawn('/bin/sh', ['-c', 'sleep 60'], {
      detached: true,
      stdio: 'ignore',
      env: { PATH: '/usr/bin:/bin', SWITCH_PI_TC: otherRun('i-1:c1') },
    });
    other.unref();
    groups.push(other.pid as number);
    const own = startGroup('sleep 60', 'i-1:c1');
    await until(() => decoyAlive(other.pid as number), 'decoy');
    expect(escapeesOf('', 'setsid sleep 30')).toBe(1);
    const registry = join(home, 'u8.jsonl');
    writeFileSync(
      registry,
      `${JSON.stringify({ v: 1, instance: 'i-1', toolCallId: 'c1', run: 1, marker: tagged('i-1:c1'), event: 'intent' })}\n`
    );
    const result = await killPiBashGroups(registry, () => true, {
      includeUnspawned: true,
      timeoutMs: 600,
      since: hostStart(),
    });
    expect(result.confirmed).toBe(true);
    expect(liveMembers(own.pid)).toBe(0);
    expect(liveMembers(other.pid as number)).toBeGreaterThan(0);
    expect(escapeesOf('', 'setsid sleep 30')).toBe(0);
  });

  // RAPKGE-03 (D-22 B): what the `ps` path makes of a shell recorded on procfs. With its label
  // (D-18 today on both paths) a group that emptied is confirmed; without one (what D-22 B would
  // record on procfs) it is never confirmed there: no proof, never a weaker identity.
  it.each([
    ['with its label', true],
    ['without a label', false],
  ] as const)(
    'RAPKGE-03: a shell recorded on procfs %s, read without procfs once its group is empty',
    async (_name, labelled) => {
      const gone = realChild.spawnSync('/bin/true').pid as number;
      const label = labelFor();
      const base = { v: 1, instance: 'i-1', toolCallId: 'c1', run: 1, marker: tagged('i-1:k3') };
      const registry = join(home, 'k3.jsonl');
      writeFileSync(
        registry,
        [
          { ...base, event: 'intent', ...(labelled ? { label } : {}) },
          {
            ...base,
            event: 'spawn',
            pid: gone,
            pgid: gone,
            starttime: '12345',
            ppid: process.pid,
            args: piBashArgsFingerprint(['/bin/bash', '-c', 'sleep 30', '/bin/bash', label]),
            ...(labelled ? { label } : {}),
          },
          { ...base, event: 'exit', pid: gone, code: 0, signal: null },
        ]
          .map((line) => `${JSON.stringify(line)}\n`)
          .join('')
      );
      const result = await killPiBashGroups(registry, () => true, {
        ...hiddenView(),
        includeUnspawned: true,
        timeoutMs: 200,
      });
      expect(result.confirmed).toBe(labelled);
      if (!labelled)
        expect(result.unconfirmed.join('; ')).toMatch(/markers of the commands could not be read/);
    }
  );

  // U-5 (R3-E in the adapter, `p1_stage4_fix3_impl.md:100`): `preparePiLaunch` gets the owner and
  // makes the launch directory with it, under `PI_RUN_PREPARING_PREFIX`, renamed into place whole.
  /** Launch directories in place (not being made or removed) without their `owner.json`. */
  const ownerless = () => {
    const run = join(stateDir(), 'run');
    if (!existsSync(run)) return [];
    return readdirSync(run).filter(
      (name) => inPlace(join(run, name)) && !existsSync(join(run, name, 'owner.json'))
    );
  };
  it.each(['config.json', 'owner.json'])(
    'U-5 (R3-E): a host that dies while %s of a launch is written leaves no launch directory without its owner',
    async (step) => {
      let seen: string[] | null = null;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      fsFaults.write = async (file) => {
        if (seen !== null || !file.endsWith(step)) return;
        // The moment a host dying would leave: what is in place now stays.
        seen = ownerless();
        await gate;
      };
      const starting = started();
      await until(() => seen !== null, `${step} being written`);
      const atThatMoment = seen;
      release();
      const { entry } = await starting;
      fsFaults.write = null;
      expect(atThatMoment).toEqual([]);
      expect(existsSync(join(dirname(entry.config!.processRegistry), 'owner.json'))).toBe(true);
      expect(ownerless()).toEqual([]);
    }
  );

  it.each(['config.json', 'owner.json'])(
    'U-5 (R3-E): a failed write of %s ends the start without a launch directory, in place or half made',
    async (step) => {
      fsFaults.write = async (file) => {
        if (file.endsWith(`/${step}`))
          throw Object.assign(new Error(`EIO: ${file} (test)`), { code: 'EIO' });
      };
      const error = await adapter()
        .startSession(input())
        .catch((caught: unknown) => caught);
      fsFaults.write = null;
      expect(String(error)).toMatch(/EIO/);
      expect(spawned).toHaveLength(0);
      const run = join(stateDir(), 'run');
      expect(existsSync(run) ? readdirSync(run) : []).toEqual([]);
      expect(heldLocks()).toEqual([]);
    }
  );

  it('U-5 (R3-E), O-9 A′: what a host left half made when it died while starting goes with the next start’s sweep once its owner is whole and gone; without a whole owner it stays', async () => {
    const run = join(stateDir(), 'run');
    const halfMade = join(run, `${PI_RUN_PREPARING_PREFIX}0b1c-dead-a`);
    const withOwner = join(run, `${PI_RUN_PREPARING_PREFIX}0b1c-dead-b`);
    for (const dir of [halfMade, withOwner]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'config.json'), '{}');
    }
    writeFileSync(
      join(withOwner, 'owner.json'),
      JSON.stringify({
        v: 1,
        pid: process.pid,
        start: deadHostStart(),
        piSessionId: '0199a5c0-0000-7000-8000-00000000fa05',
      })
    );
    await started();
    expect(readdirSync(run).filter((name) => name.startsWith(PI_RUN_PREPARING_PREFIX))).toEqual([
      basename(halfMade),
    ]);
    expect(ownerless()).toEqual([]);
  });

  // U-5: the sweep of every start looks at what is under `PI_RUN_PREPARING_PREFIX`
  // (`pi-adapter.ts` `sweepDeadHosts`), which is also where a start in progress makes its launch;
  // in joint round 4 the first start failed here (ENOENT) without `preparingLaunches`. Joint
  // round 5 (O-9 A′): no count; the launch being made has no whole owner yet (paused before it is
  // written, owner first), or names this process, which runs: the sweep leaves it either way.
  it('U-5: a start in progress is not swept away by another start’s sweep at the same moment', async () => {
    let paused = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    fsFaults.write = async (file) => {
      if (
        paused ||
        !file.includes(`/run/${PI_RUN_PREPARING_PREFIX}`) ||
        !file.endsWith('/owner.json')
      )
        return;
      paused = true;
      await gate;
    };
    const first = adapter()
      .startSession(input())
      .then(
        () => 'started',
        (error: unknown) => String(error)
      );
    await until(() => paused, 'the first start making its launch');
    const second = await adapter()
      .startSession(input())
      .then(
        () => 'started',
        (error: unknown) => String(error)
      );
    release();
    const outcome = await first;
    fsFaults.write = null;
    flowsOut.push({ id: 'U-5-race', first: outcome.slice(0, 200), second: second.slice(0, 200) });
    // eslint-disable-next-line no-console
    console.log(`U-5 race: first=${outcome.slice(0, 200)}; second=${second.slice(0, 80)}`);
    expect(second).toBe('started');
    expect(outcome).toBe('started');
    expect(ownerless()).toEqual([]);
  });

  // ---------------------------------------------------------------------------------------------
  // Joint round 5 (09zf O-1 A, 09zh O-2 B and O-9 A′, FAP-14).

  // O-9 A′ (S4-11, `decaudit_sol_review.md` Q2): two independent processes on one state directory,
  // nothing shared but the files. Another `node` makes a launch directory as `preparePiLaunch` does
  // (`.preparing-<id>`, its owner first, naming itself) and pauses; this process's start sweeps.
  /** Another process making a launch directory, paused after its owner (until `go`). */
  function otherMaker(id: string) {
    const run = join(stateDir(), 'run');
    const at = mkdtempSync(join(home, 'maker-'));
    const [gate, ready] = [join(at, 'gate'), join(at, 'ready')];
    const source = [
      'const fs = process.getBuiltinModule("node:fs");',
      'const path = process.getBuiltinModule("node:path");',
      'const crypto = process.getBuiltinModule("node:crypto");',
      'const [run, gate, ready, id, prefix] = process.argv.slice(1);',
      'const stat = fs.readFileSync("/proc/self/stat", "utf8");',
      'const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];',
      'const making = path.join(run, prefix + crypto.randomUUID());',
      'fs.mkdirSync(run, { recursive: true });',
      'fs.mkdirSync(making, { mode: 0o700 });',
      'fs.writeFileSync(path.join(making, "owner.json"), JSON.stringify({ v: 1, pid: process.pid, start, piSessionId: id }), { flag: "wx", mode: 0o600 });',
      'fs.writeFileSync(ready, making);',
      'const nap = new Int32Array(new SharedArrayBuffer(4));',
      'while (!fs.existsSync(gate)) Atomics.wait(nap, 0, 0, 10);',
      'fs.writeFileSync(path.join(making, "config.json"), "{}", { flag: "wx", mode: 0o600 });',
      'fs.renameSync(making, path.join(run, "made-by-another"));',
      'process.stdout.write("renamed");',
    ].join('\n');
    const child = realChild.spawn(
      process.execPath,
      ['-e', source, run, gate, ready, id, PI_RUN_PREPARING_PREFIX],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((resolve) =>
      child.on('exit', (code) => resolve(code))
    );
    return {
      child,
      making: async () => {
        await until(() => existsSync(ready), 'the other process making its launch', 10_000);
        return readFileSync(ready, 'utf8');
      },
      go: () => writeFileSync(gate, ''),
      done: async () => ({ code: await exited, out, err }),
    };
  }

  it('O-9 A′: a launch another process is making is not swept away by this process’s start; the other finishes it', async () => {
    const other = otherMaker('0199a5c0-0000-7000-8000-0000000009a1');
    const making = await other.making();
    expect(basename(making).startsWith(PI_RUN_PREPARING_PREFIX)).toBe(true);
    await started();
    expect(existsSync(join(making, 'owner.json'))).toBe(true);
    other.go();
    const done = await other.done();
    expect(done).toMatchObject({ code: 0, out: 'renamed' });
    expect(existsSync(join(stateDir(), 'run', 'made-by-another', 'config.json'))).toBe(true);
  }, 20_000);

  it('O-9 A′: a launch whose maker died while making it (its owner whole) goes with the next start’s sweep', async () => {
    const other = otherMaker('0199a5c0-0000-7000-8000-0000000009a2');
    const making = await other.making();
    other.child.kill('SIGKILL');
    await other.done();
    await started();
    expect(existsSync(making)).toBe(false);
    expect(readdirSync(join(stateDir(), 'run')).filter((name) => name.startsWith('.'))).toEqual([]);
  }, 20_000);

  // O-9 A′: what a host that dies at each step of making a launch leaves, and what the next sweep
  // does with it (the disposition table of the report). `owner`: as written then.
  const LIVE = () => ({
    v: 1,
    pid: process.pid,
    start: hostStart(),
    piSessionId: '0199a5c0-0000-7000-8000-0000000009b1',
  });
  const DEAD = () => ({ ...LIVE(), start: deadHostStart() });
  it.each([
    ['after mkdir (no owner yet)', PI_RUN_PREPARING_PREFIX, null, false, true],
    ['in the write of the owner (cut off)', PI_RUN_PREPARING_PREFIX, 'cut', false, true],
    ['after the owner, its host gone', PI_RUN_PREPARING_PREFIX, 'dead', false, false],
    ['after the config, its host gone', PI_RUN_PREPARING_PREFIX, 'dead', true, false],
    ['after the config, its host live', PI_RUN_PREPARING_PREFIX, 'live', true, true],
    ['after the rename, its host gone (a launch in place, no Pi)', '', 'dead', true, false],
    ['in the removal (renamed for it, its owner already gone)', '.removed-', null, true, false],
    [
      'a directory of joint round 4 made under .removed- by a live host',
      '.removed-',
      'live',
      true,
      false,
    ],
  ] as const)(
    'O-9 A′: a host dying %s: the next sweep keeps it (%s)',
    async (_step, prefix, owner, config, kept) => {
      const dir = join(stateDir(), 'run', `${prefix}0b1c-step`);
      mkdirSync(dir, { recursive: true });
      if (owner === 'cut') writeFileSync(join(dir, 'owner.json'), '{"v":1,"pid":12');
      else if (owner)
        writeFileSync(join(dir, 'owner.json'), JSON.stringify(owner === 'dead' ? DEAD() : LIVE()));
      if (config) writeFileSync(join(dir, 'config.json'), '{}');
      // A procfs of this process only: what the sweep looks for is exactly what is made here.
      await started(adapter({ procRoot: smallProc() }));
      expect(existsSync(dir)).toBe(kept);
      // Nothing it leaves is a launch in place without its owner (R3-E).
      expect(ownerless()).toEqual([]);
    }
  );

  it('O-9 A′: a removal of a dead host’s launch being made that fails at its rename leaves it as it was; the next sweep removes it', async () => {
    const dir = join(stateDir(), 'run', `${PI_RUN_PREPARING_PREFIX}0b1c-rename`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(DEAD()));
    fsFaults.rm = async (file, real) => {
      if (file === dir) throw Object.assign(new Error(`EIO: ${file} (test)`), { code: 'EIO' });
      return real();
    };
    await started();
    fsFaults.rm = null;
    expect(existsSync(join(dir, 'owner.json'))).toBe(true);
    await started();
    expect(existsSync(dir)).toBe(false);
  });

  // O-2 B (FAP-06; Fable F1-01, `fap_fable_review.md:55`, `:163-164`; its files were not kept, so
  // rebuilt from the description): the PID of a shell, reaped and given again to a process that
  // leads its own session, is not counted as the shell's group.
  const shellRecords = (
    pid: number,
    shell: { toolCallId: string; marker: string; exit?: boolean } & Record<string, unknown>
  ) => {
    const { toolCallId, marker, exit, run = 1, ...spawn } = shell;
    const base = { v: 1, instance: 'i-1', toolCallId, run, marker: tagged(marker) };
    return [
      { ...base, event: 'intent' },
      { ...base, event: 'spawn', pid, pgid: pid, ...spawn },
      ...(exit ? [{ ...base, event: 'exit', pid, code: 0, signal: null }] : []),
    ];
  };
  const writeRegistry = (name: string, lines: unknown[]) => {
    const registry = join(home, name);
    writeFileSync(registry, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
    return registry;
  };
  const other = (starttime: string) => String(BigInt(starttime) + 1n);

  it.each([
    ['without its exit', false],
    ['with its exit', true],
  ] as const)(
    'O-2 B (procfs, Fable F1-01 %s): a group whose number another session leader with another start took is empty; nothing is sent to it',
    async (_name, exit) => {
      const foreign = startGroup('sleep 60', 'i-9:foreign');
      const registry = writeRegistry('reuse.jsonl', [
        ...shellRecords(foreign.pid, {
          toolCallId: 'f1',
          marker: 'i-1:f1',
          starttime: other(foreign.starttime),
          exit,
        }),
      ]);
      const result = await killPiBashGroups(registry, () => true, {
        includeUnspawned: true,
        timeoutMs: 300,
        since: hostStart(),
      });
      expect(result).toEqual({ confirmed: true, killed: 0, unconfirmed: [] });
      expect(liveMembers(foreign.pid)).toBeGreaterThan(0);
    }
  );

  it('O-2 B (procfs) controls: the same identity still counts (signalled when it is the bridge’s, left counted when it cannot be); no start recorded, or no leader left, counts', async () => {
    const options = { includeUnspawned: true, timeoutMs: 300, since: hostStart() } as const;
    // The shell itself, with its marker: verified, killed, confirmed (as before).
    const own = startGroup('sleep 60', 'i-1:f2');
    const killedOwn = await killPiBashGroups(
      writeRegistry(
        'own.jsonl',
        shellRecords(own.pid, { toolCallId: 'f2', marker: 'i-1:f2', starttime: own.starttime })
      ),
      () => true,
      options
    );
    expect(killedOwn).toMatchObject({ confirmed: true, killed: 1 });
    // The same start but not the bridge's marker: not signalled, and its members count.
    const same = startGroup('sleep 60', 'i-9:same');
    const kept = await killPiBashGroups(
      writeRegistry(
        'same.jsonl',
        shellRecords(same.pid, { toolCallId: 'f3', marker: 'i-1:f3', starttime: same.starttime })
      ),
      () => true,
      options
    );
    expect(kept.confirmed).toBe(false);
    expect(kept.unconfirmed.join('; ')).toMatch(/f3: \d+ process\(es\) left/);
    // No start recorded: whose the leader is cannot be told, so its members count.
    const unknown = await killPiBashGroups(
      writeRegistry(
        'unknown.jsonl',
        shellRecords(same.pid, { toolCallId: 'f4', marker: 'i-1:f4', starttime: null })
      ),
      () => true,
      options
    );
    expect(unknown.unconfirmed.join('; ')).toMatch(/f4: \d+ process\(es\) left/);
    // A start not in procfs's form is no identity either (R7-A): never "another process".
    const garbled = await killPiBashGroups(
      writeRegistry(
        'garbled.jsonl',
        shellRecords(same.pid, { toolCallId: 'f6', marker: 'i-1:f6', starttime: 'x1' })
      ),
      () => true,
      options
    );
    expect(garbled.unconfirmed.join('; ')).toMatch(/f6: \d+ process\(es\) left/);
    // The leader gone, a member left (no marker of the bridge's, so not signalled): counted,
    // whatever start was recorded; only a live leader with another start says the number is free.
    const orphaned = startGroup('sleep 60 & exit 0', 'i-9:orphan');
    await until(() => {
      const leader = readPiProcStat(orphaned.pid);
      return leader === undefined || leader.state === 'Z';
    }, 'the leader gone');
    const left = await killPiBashGroups(
      writeRegistry(
        'orphan.jsonl',
        shellRecords(orphaned.pid, {
          toolCallId: 'f5',
          marker: 'i-1:f5',
          starttime: other(orphaned.starttime),
        })
      ),
      () => true,
      options
    );
    expect(left.unconfirmed.join('; ')).toMatch(/f5: \d+ process\(es\) left/);
  });

  it.each([
    ['the older first', false],
    ['the newer first', true],
  ] as const)(
    'O-2 B (R5P-02, %s): two shells recorded with one group number; the one whose start the leader has still counts, the other does not',
    async (_name, newerFirst) => {
      const leader = startGroup('sleep 60', 'i-9:ab');
      const older = shellRecords(leader.pid, {
        toolCallId: 'a',
        marker: 'i-1:a',
        starttime: other(leader.starttime),
      });
      const newer = shellRecords(leader.pid, {
        toolCallId: 'b',
        marker: 'i-1:b',
        starttime: leader.starttime,
      });
      const result = await killPiBashGroups(
        writeRegistry('ab.jsonl', newerFirst ? [...newer, ...older] : [...older, ...newer]),
        () => true,
        { includeUnspawned: true, timeoutMs: 300, since: hostStart() }
      );
      expect(result.confirmed).toBe(false);
      expect(result.unconfirmed.join('; ')).toMatch(/\bb: \d+ process\(es\) left/);
      expect(result.unconfirmed.join('; ')).not.toMatch(/\ba: \d+ process\(es\) left/);
    }
  );

  it.each([
    ['another start (its number taken again): no background work', true, false],
    ['the same start (control): background work', false, true],
  ] as const)(
    'O-2 B (procfs, surveyGroups): a command of an earlier run whose group leader has %s',
    async (_name, reused, background) => {
      const made = adapter();
      const { given, entry } = await started(made);
      await made.sendTurn({ sessionId: given.sessionId, turnId: 't', text: 'x' });
      await until(() => prompts(entry.pi).length === 1, 'prompt');
      // Not the bridge's marker: nothing of the interrupt signals it.
      const leader = startGroup('sleep 60', 'i-9:survey');
      writeFileSync(
        entry.config!.processRegistry,
        shellRecords(leader.pid, {
          toolCallId: 'old',
          marker: 'i-1:old',
          run: 0,
          starttime: reused ? other(leader.starttime) : leader.starttime,
        })
          .map((line) => `${JSON.stringify(line)}\n`)
          .join(''),
        { flag: 'a' }
      );
      await made.interruptTurn(given.sessionId);
      settle(entry.pi, true);
      await until(() => completed('t').length === 1, 'turn');
      await until(() => of('session.state.changed').at(-1)?.status === 'ready', 'ready');
      expect(made.hasBackgroundWork(given.sessionId)).toBe(background);
      expect(decoyAlive(leader.pid)).toBe(true);
    }
  );

  it.each([
    ['another lstart', false, true],
    ['the same second (the same lstart)', true, false],
  ] as const)(
    'O-2 B (ps, Fable F1-01 rebuilt): a group whose leader has %s',
    async (_name, sameSecond, confirmed) => {
      const foreign = realChild.spawn('/bin/sleep', ['60'], { detached: true, stdio: 'ignore' });
      foreign.unref();
      const pid = foreign.pid as number;
      groups.push(pid);
      await until(() => lstartOf(pid) !== undefined, 'the leader');
      const registry = writeRegistry('reuse-ps.jsonl', [
        ...shellRecords(pid, {
          toolCallId: 'p1',
          marker: 'i-1:p1',
          starttime: null,
          lstart: sameSecond ? lstartOf(pid) : 'Mon Jan  1 00:00:00 2024',
          label: labelFor(),
        }),
      ]);
      const result = await killPiBashGroups(registry, () => true, {
        ...hiddenView(),
        includeUnspawned: true,
        timeoutMs: 300,
      });
      expect(result.confirmed).toBe(confirmed);
      if (!confirmed) expect(result.unconfirmed.join('; ')).toMatch(/p1: 1 process\(es\) left/);
      expect(decoyAlive(pid)).toBe(true);
    }
  );

  // O-1 A: a later try of a recorded launch (one recorded before the proof, or by a stop that did
  // not see Pi exit) that sees its Pi gone (procfs, every process read) keeps that in the record,
  // merged into its entry, while a group of it still runs.
  it('O-1 A (procfs): a later try that sees the Pi of a recorded launch gone keeps it in the record while a group still runs', async () => {
    const ID = '0199a5c0-0000-7000-8000-0000000009c1';
    const run = join(stateDir(), 'run', 'launch-upgrade');
    mkdirSync(run, { recursive: true });
    // Its leader has not the registry's marker: verified as not the bridge's, never signalled.
    const group = startGroup('sleep 60', 'i-9:upgrade');
    writeFileSync(
      join(run, 'processes.jsonl'),
      shellRecords(group.pid, { toolCallId: 'u1', marker: 'i-1:u1', starttime: group.starttime })
        .map((line) => `${JSON.stringify(line)}\n`)
        .join('')
    );
    const owner = { pid: process.pid, start: deadHostStart() };
    writeFileSync(join(run, 'owner.json'), JSON.stringify({ v: 1, ...owner, piSessionId: ID }));
    writeTranscript(ID, join(home, 'project'));
    const file = join(sessionDir(), `${ID}.cleanup.json`);
    const entry = {
      runDir: run,
      registry: join(run, 'processes.jsonl'),
      bridgeConfig: join(run, 'config.json'),
      owner,
    };
    writeFileSync(file, JSON.stringify({ v: 1, launches: [entry] }));
    const outcome = await adapter({ procRoot: smallProc([group.pid]), cleanupTimeoutMs: 300 })
      .startSession(input({ resume: { nativeSessionId: ID } }))
      .then(
        () => 'started',
        (error: unknown) => String(error)
      );
    expect(outcome).toMatch(/u1: \d+ process\(es\) left/);
    expect(outcome).not.toMatch(/Pi: /);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      v: 1,
      launches: [{ ...entry, piExited: true }],
    });
  });

  // FAP-14 (FAPM M-01, R2-E1): `sendTurn` checks a blocked cleanup again as an operation of the
  // session (`run`): a stop meanwhile waits for it, so the session is not reported gone and its
  // conversation not let go before that check settled (one life of a session, R5).
  it('FAP-14: a stop while sendTurn checks a blocked cleanup again waits for that check; the message is refused after it', async () => {
    const made = adapter();
    const { given, session } = await started(made);
    const id = given.sessionId;
    const live = internals(made).sessions.get(id) as SessionView;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let checking = false;
    live.blocked = {
      reason: 'a test block',
      recheck: async () => {
        checking = true;
        await gate;
        return { confirmed: true, killed: 0, unconfirmed: [] };
      },
    };
    const sending = made.sendTurn({ sessionId: id, turnId: 'late', text: 'y' }).then(
      () => 'accepted',
      (error: unknown) => String(error)
    );
    await until(() => checking, 'the check under way');
    let stopped = false;
    const stopping = made.stopSession(id).then(() => {
      stopped = true;
    });
    await pause(300);
    expect(stopped).toBe(false);
    expect(of('session.exited', id)).toHaveLength(0);
    expect(heldLocks()).toEqual([`${session.nativeSessionId}.lock`]);
    release();
    await stopping;
    expect(await sending).toMatch(/stopped while Switch checked its cleanup/);
    expect(of('session.exited', id)).toHaveLength(1);
    expect(heldLocks()).toEqual([]);
    expect(completed('late')).toHaveLength(0);
  });
});
