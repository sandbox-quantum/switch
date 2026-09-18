import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  ensureSharedProcess,
  runSharedWatcher,
  type SharedHostConfig,
  superviseSharedHost,
  type Supervision,
} from '@switch-console/agent-providers';
import { resolveSharedHostBundlePath } from '@main/core/agent-runtime/impl/resolve-sidecar-bundle';
import { log } from '@main/lib/logger';
import { clearStaleOwners } from './local-host-owners';

/**
 * Local hosts belong to Console's process tree: a local agent must not answer
 * when Console is off. Everything started here hangs off this controller, so
 * quitting Console stops the watchers and the sessions they started.
 */
const consoleLifetime = new AbortController();

const watchers = new Map<string, { stop: AbortController; done: Promise<void> }>();
const sessions = new Map<string, { stop: AbortController; done: Promise<void> }>();

export function localStateBase(kind: 'sdk-sessions' | 'sdk-watchers'): string {
  return join(homedir(), '.local', 'state', 'switch', kind);
}

export function savedAgentId(root: string): string | null {
  try {
    return JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')).session.agentId;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Resolves the watcher state root for an agent, adopting a directory saved
 * under an earlier key so a rename does not strand its journal.
 */
export function localWatcherRoot(identity: string): string {
  const base = localStateBase('sdk-watchers');
  const keyed = join(base, createHash('sha256').update(identity).digest('hex'));
  if (!existsSync(base)) return keyed;
  const matches = readdirSync(base).filter((name) => savedAgentId(join(base, name)) === identity);
  if (matches.length > 1) throw new Error('Competing saved watchers require explicit cleanup.');
  return matches[0] ? join(base, matches[0]) : keyed;
}

async function writeAtomic(destination: string, body: unknown): Promise<void> {
  const temporary = `${destination}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(JSON.stringify(body));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, destination);
}

export async function writeWatchEnabled(root: string, enabled: boolean): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeAtomic(join(root, 'watch.json'), { enabled });
}

/**
 * The agent panel tails this file. A deployed host writes it from its own
 * process; one running inside Console has to append here, or the panel would
 * show a log that stopped updating the day the host moved in-process.
 */
async function note(root: string, line: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await appendFile(join(root, 'supervisor.log'), `${new Date().toISOString()} ${line}\n`, {
    mode: 0o600,
  });
}

/**
 * Records why a host stopped where the agent's panel reads it. A deployed host
 * writes this from its own process; one running inside Console has to write it
 * here, or the panel would report the watcher as down with no reason.
 */
async function recordFailure(root: string, message: string): Promise<void> {
  await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
  await writeAtomic(join(root, 'supervisor', 'failure.json'), { message });
  await note(root, `Room watcher stopped: ${message}`);
}

function track(
  registry: Map<string, { stop: AbortController; done: Promise<void> }>,
  root: string,
  run: (signal: AbortSignal) => Promise<void>,
  describe: string,
  report: boolean
): void {
  if (registry.has(root)) return;
  const stop = new AbortController();
  const done = run(AbortSignal.any([stop.signal, consoleLifetime.signal]))
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      log.error(describe, { root, error: message });
      if (!report || consoleLifetime.signal.aborted) return;
      await recordFailure(root, message).catch((failure: unknown) => {
        log.error('Could not record why a local host stopped', {
          root,
          error: String(failure),
        });
      });
    })
    .finally(() => {
      registry.delete(root);
    });
  registry.set(root, { stop, done });
}

async function halt(
  registry: Map<string, { stop: AbortController; done: Promise<void> }>,
  root: string
): Promise<void> {
  const entry = registry.get(root);
  if (!entry) return;
  entry.stop.abort();
  await entry.done;
}

/**
 * Supervises a local host from inside Console. The worker keeps its own process
 * group so a misbehaving provider can still be fenced, but Console owns the
 * supervisor rather than detaching one, so the worker stops when Console does.
 */
export const consoleSupervision: Supervision = {
  start: async ({ root, configPath, watcher }) => {
    const bundle = resolveSharedHostBundlePath();
    track(
      sessions,
      root,
      (signal) =>
        superviseSharedHost({
          root,
          executable: process.execPath,
          args: [bundle, root, configPath, ...(watcher ? ['--watch-worker'] : [])],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
          signal,
        }),
      'Local SDK host supervisor stopped',
      // The supervisor records a worker's own failure under this root already.
      false
    );
  },
  stop: (root) => halt(sessions, root),
};

/** Starts a session Console supervises itself, in place of deploying a host. */
export async function startLocalSession(
  root: string,
  config: SharedHostConfig,
  options: { resuming: boolean; restart: boolean }
): Promise<void> {
  await ensureSharedProcess({
    root,
    config,
    resuming: options.resuming,
    watcher: false,
    restart: options.restart,
    supervision: consoleSupervision,
  });
}

/** The failure a local host recorded before giving up, or null if it has not. */
export async function readLocalHostFailure(root: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(root, 'supervisor', 'failure.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Runs the room watcher inside Console rather than deploying a detached host. */
export async function startLocalWatcher(config: SharedHostConfig): Promise<void> {
  const root = localWatcherRoot(config.session.agentId);
  await clearStaleOwners(root);
  await writeWatchEnabled(root, true);
  await ensureSharedProcess({
    root,
    config,
    resuming: false,
    watcher: true,
    restart: false,
    supervision: {
      start: async ({ root: prepared }) => {
        await note(prepared, 'Room watcher started inside Console.');
        track(
          watchers,
          prepared,
          (signal) => runSharedWatcher(prepared, config, signal, consoleSupervision),
          'Local room watcher stopped',
          true
        );
      },
      stop: (target) => halt(watchers, target),
    },
  });
}

export async function stopLocalWatcher(identity: string): Promise<void> {
  const root = localWatcherRoot(identity);
  await writeWatchEnabled(root, false);
  await halt(watchers, root);
}

/** Stops every local watcher and session so none of them outlives Console. */
export async function disposeLocalHosts(): Promise<void> {
  consoleLifetime.abort();
  await Promise.allSettled([...watchers.values(), ...sessions.values()].map((entry) => entry.done));
}
