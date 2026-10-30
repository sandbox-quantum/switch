import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { delimiter } from 'node:path';
import { createInterface } from 'node:readline';
import type { Fetch } from '../api';
import type { RunCommand } from './hardware';

/** How llama-server is started for one model. */
export type ModelServerSpec = {
  binary: string;
  /** Directories holding the shared libraries the build loads. */
  libraryDirs: string[];
  modelFile: string;
  contextSize: number;
  parallel: number;
  gpuLayers: number;
  /** CPU threads, for a build that runs on the CPU; null leaves it to llama.cpp. */
  threads: number | null;
};

/** How a model server ended. */
export type ModelServerExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** What it last printed says it ran out of memory. */
  outOfMemory: boolean;
};

/** A model server this controller started, on loopback, answering only to its key. */
export type ModelServerHandle = {
  readonly port: number;
  readonly apiKey: string;
  readonly pid: number | null;
  readonly exited: Promise<ModelServerExit>;
  /** Asks it to end, then kills it if it has not within a few seconds. */
  stop(): Promise<void>;
};

export type LaunchModelServer = (spec: ModelServerSpec) => Promise<ModelServerHandle>;

const STOP_GRACE_MS = 5_000;
const KEPT_LINES = 30;
const LINE_LIMIT = 300;
const OUT_OF_MEMORY =
  /out of memory|failed to allocate|unable to allocate|cudaMalloc failed|insufficient memory|OutOfMemory/i;

/**
 * llama-server's arguments: loopback only, no web UI, no slots endpoint (it
 * would show the prompts being worked on), no log file and the default
 * verbosity (which prints no prompt; what it prints is never written
 * anywhere, see `spawnModelServer`), no network access of its own, and no
 * prompt cache in RAM beyond its slots.
 */
export function modelServerArgs(spec: ModelServerSpec, port: number): string[] {
  return [
    '--model',
    spec.modelFile,
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    String(spec.contextSize),
    '--parallel',
    String(spec.parallel),
    '--n-gpu-layers',
    String(spec.gpuLayers),
    ...(spec.threads !== null ? ['--threads', String(spec.threads)] : []),
    '--no-webui',
    '--no-slots',
    '--cache-ram',
    '0',
    '--offline',
  ];
}

/**
 * The environment llama-server runs with: a path, a home and the library
 * path, and its key. Nothing else of the controller's, whose environment
 * carries the agents' provider keys.
 */
export function modelServerEnv(
  spec: ModelServerSpec,
  apiKey: string,
  from: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LLAMA_API_KEY: apiKey };
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG']) if (from[name]) env[name] = from[name];
  if (spec.libraryDirs.length > 0) {
    const libraries = spec.libraryDirs.join(delimiter);
    env.LD_LIBRARY_PATH = from.LD_LIBRARY_PATH
      ? `${libraries}${delimiter}${from.LD_LIBRARY_PATH}`
      : libraries;
  }
  return env;
}

/** A loopback port free now, for the model server to listen on. */
export async function freeLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/**
 * Starts llama-server as a child process, on a free loopback port with a key
 * made for this launch (given in its environment, never on its command line,
 * which other users of the machine can read). What it prints is held in
 * memory only, its last lines, to tell an out-of-memory end from another: it
 * is never logged.
 */
export function spawnModelServer(env: NodeJS.ProcessEnv): LaunchModelServer {
  return async (spec) => {
    const port = await freeLoopbackPort();
    const apiKey = randomBytes(24).toString('base64url');
    const child = spawn(spec.binary, modelServerArgs(spec, port), {
      env: modelServerEnv(spec, apiKey, env),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const tail: string[] = [];
    for (const stream of [child.stdout, child.stderr]) {
      if (!stream) continue;
      createInterface({ input: stream, crlfDelay: Infinity }).on('line', (line) => {
        tail.push(line.slice(0, LINE_LIMIT));
        if (tail.length > KEPT_LINES) tail.shift();
      });
    }
    const exited = new Promise<ModelServerExit>((resolve) => {
      let done = false;
      const finish = (code: number | null, signal: NodeJS.Signals | null) => {
        if (done) return;
        done = true;
        resolve({ code, signal, outOfMemory: tail.some((line) => OUT_OF_MEMORY.test(line)) });
      };
      child.once('error', () => finish(null, null));
      child.once('exit', finish);
    });
    return {
      port,
      apiKey,
      pid: child.pid ?? null,
      exited,
      stop: async () => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill('SIGTERM');
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ended = await Promise.race([
          exited.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
          }),
        ]);
        clearTimeout(timer);
        if (!ended) {
          child.kill('SIGKILL');
          await exited;
        }
      },
    };
  };
}

/**
 * Waits until the model server says it is ready (`GET /health` answers 200
 * once the model is loaded), polling every `intervalMs`. Rejects when it
 * exits first, `timeoutMs` passes, or `signal` fires.
 */
export async function waitHealthy(input: {
  fetch: Fetch;
  server: ModelServerHandle;
  timeoutMs: number;
  intervalMs: number;
  signal: AbortSignal;
}): Promise<void> {
  const { server, signal } = input;
  let ended: ModelServerExit | null = null;
  void server.exited.then((exit) => {
    ended = exit;
  });
  const deadline = Date.now() + input.timeoutMs;
  for (;;) {
    signal.throwIfAborted();
    if (ended) throw new ModelServerEnded(ended);
    try {
      const response = await input.fetch(`http://127.0.0.1:${server.port}/health`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(2_000)]),
      });
      await response.body?.cancel();
      if (response.status === 200) return;
    } catch (error) {
      if (signal.aborted) throw error;
    }
    if (Date.now() > deadline)
      throw new Error(`The model server was not ready within ${input.timeoutMs / 1000} s.`);
    await new Promise((resolve) => setTimeout(resolve, input.intervalMs));
  }
}

/** The model server exited while it was being waited on. */
export class ModelServerEnded extends Error {
  constructor(readonly exit: ModelServerExit) {
    super(
      `The model server exited${exit.code !== null ? ` with code ${exit.code}` : exit.signal ? ` on ${exit.signal}` : ''}${exit.outOfMemory ? ', out of memory' : ''}.`
    );
  }
}

/**
 * The warm-up decision: a fixed sample with nothing from any room, shaped as
 * Switch's decision payloads are (one token, its log-probabilities), so the
 * first real decision does not pay for loading the GPU's kernels.
 */
export const WARM_UP_PAYLOAD = {
  messages: [
    {
      role: 'system',
      content:
        'You route a chat message to one agent. Answer with the letter of the agent, or N for none.',
    },
    {
      role: 'user',
      content:
        'Agents:\nA: deploy-bot (deploys services)\nB: docs-bot (answers documentation questions)\n\nMessage: how do I roll back the last deploy?\n\nAnswer:',
    },
  ],
  max_tokens: 1,
  temperature: 0,
  logprobs: true,
  top_logprobs: 20,
  chat_template_kwargs: { enable_thinking: false },
};

/** Records the model server's process, so a controller that died leaving it running can stop it. */
export type StaleServers = {
  record(pid: number, binary: string): Promise<void>;
  clear(): Promise<void>;
  /** Stops a model server an earlier run recorded and left running. */
  stopStale(): Promise<void>;
};

export function pidFileStaleServers(input: {
  file: string;
  run: RunCommand;
  kill: (pid: number, signal: NodeJS.Signals) => void;
}): StaleServers {
  return {
    record: (pid, binary) =>
      writeFile(input.file, JSON.stringify({ pid, binary }), { mode: 0o600 }),
    clear: () => rm(input.file, { force: true }),
    stopStale: async () => {
      let recorded: { pid?: unknown; binary?: unknown };
      try {
        recorded = JSON.parse(await readFile(input.file, 'utf8')) as typeof recorded;
      } catch {
        return;
      }
      await rm(input.file, { force: true });
      if (typeof recorded.pid !== 'number' || typeof recorded.binary !== 'string') return;
      // Only the process the record names, still running that binary: a pid
      // reused since by something else is left alone.
      const command = await input
        .run('ps', ['-o', 'command=', '-p', String(recorded.pid)])
        .catch(() => '');
      if (!command.trim().startsWith(recorded.binary)) return;
      try {
        input.kill(recorded.pid, 'SIGTERM');
      } catch {}
    },
  };
}
