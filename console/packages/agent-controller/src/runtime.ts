import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  clearTakenOver,
  ensureSharedProcess,
  inProcessSupervision,
  type OpenAgentStream,
  type ProviderReadiness,
  providerReadinessSchema,
  readTakenOver,
  readWatchFlags,
  recordWatcherHealth,
  runAgentHost,
  SessionLinks,
  sharedConfigSchema,
  type SharedHostConfig,
  type Supervision,
  type TakenOver,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  WatcherControl,
  type WatcherHealthFile,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers';
import { ConfigurationError, ReasonedError } from './errors';
import { errorMessage, type Logger } from './log';
import type { DataLayout } from './paths';
import type { Isolation, Provider } from './schemas';

const execute = promisify(execFile);

/** What is on disk and alive for one agent's agent host. */
export type AgentObservation = {
  /** The agent host or its supervisor is running. */
  alive: boolean;
  /** The provider and working directory its saved configuration was created with. */
  configured: { provider: string; cwd: string } | null;
  flags: WatchFlags | null;
  /** `current` is false when the process that wrote it is gone. */
  health: (WatcherHealthFile & { current: boolean }) | null;
  /** `supervisor/failure.json`: why the agent host stopped and was not restarted. */
  failure: string | null;
  takenOver: TakenOver | null;
};

/** What an agent with no agent host root at all looks like. */
export function emptyObservation(): AgentObservation {
  return {
    alive: false,
    configured: null,
    flags: null,
    health: null,
    failure: null,
    takenOver: null,
  };
}

export type LaunchOptions = {
  /** Where the agent host runs: in this controller's process, or in one of its own. */
  isolation: Isolation;
  /** Stop a running agent host first, so the new configuration takes effect. */
  restart: boolean;
  /** Restart into a different provider or working directory: the saved configuration goes. */
  replaceIdentity: boolean;
  /** Someone asked for this agent host on purpose: a standing-down marker is cleared. */
  clearTakenOver: boolean;
};

/** What an agent host reads to reach Switch: the controller's relay, and a token for it. */
export type RelayCredentials = { endpoint: string; token: string };

/** Runs agent hosts one way: in this controller's process, or each in a process of its own. */
export interface AgentRunner {
  observe(agentId: string): Promise<AgentObservation>;
  launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void>;
  /** Turns the agent host off; with `wait`, returns once it and its sessions are gone. */
  stop(agentId: string, options: { wait: boolean }): Promise<void>;
  /** The controller is exiting. */
  close(): Promise<void>;
}

/**
 * How the controller runs agents on this machine (`AgentRuntimes`, over an
 * `InProcessRuntime` and a runner for isolated agents); tests substitute a
 * fake.
 */
export interface AgentRuntime extends AgentRunner {
  credentialsPath(agentId: string): string;
  /** The credentials file as written, or null when there is none or it cannot be read. */
  readCredentials(agentId: string): Promise<RelayCredentials | null>;
  writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void>;
  deleteCredentials(agentId: string): Promise<void>;
  /** `directory` from the definition, or a workspace under the data directory. */
  workingDirectory(name: string, directory: string | null): Promise<string>;
  probe(provider: Provider, binaryPath: string, cwd: string): Promise<ProviderReadiness>;
}

/** How long an agent host asked to stop is given; each session host is allowed 20 s of it. */
export const STOP_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 90_000;
/** Failures an agent host is started again after, within `CRASH_WINDOW_MS`. */
const MAX_CRASHES = 3;
const CRASH_WINDOW_MS = 10 * 60 * 1000;
/**
 * What an agent host run in the controller's process records as its build: never
 * the shared-host bundle a detached agent host records, so one left by an
 * earlier controller is replaced rather than taken for this one.
 */
const IN_PROCESS_BUILD = 'switch-agent-controller:in-process';

export async function writeAtomic(path: string, body: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}`;
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(body);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
}

export async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeOptional(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** A saved PID counts only while it still names a process started for this root. */
export async function ownsRoot(pid: number, root: string): Promise<boolean> {
  if (!alive(pid)) return false;
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes(root);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

export async function recordedPid(path: string): Promise<number | null> {
  const text = await readOptional(path);
  if (text === null) return null;
  const pid = (JSON.parse(text) as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** The owner records an agent host writes under its root: the worker's, then a detached one's supervisor's. */
export const OWNER_RECORDS = ['shared-owner.lock', join('supervisor', 'owner.json')];

/** The shared host needs POSIX process control: macOS or Linux. */
export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === 'win32')
    throw new ConfigurationError(
      'The agents controller runs agents through the shared host, which needs a macOS or Linux machine.'
    );
}

/** What is on disk for one agent's agent host, read by a process that does not run it (`status`). */
export async function observeOnDisk(
  layout: DataLayout,
  agentId: string
): Promise<AgentObservation> {
  const root = layout.watcherRoot(agentId);
  const pid = await recordedPid(join(root, 'shared-owner.lock'));
  const running = pid !== null && alive(pid);
  const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
  const health =
    healthText === null
      ? null
      : { ...watcherHealthFileSchema.parse(JSON.parse(healthText)), current: running };
  return { ...(await readRoot(root)), alive: running, health };
}

/** Everything about an agent host root but whether it runs. */
export async function readRoot(root: string): Promise<Omit<AgentObservation, 'alive'>> {
  const config = await readOptional(join(root, 'config.json'));
  let configured: AgentObservation['configured'] = null;
  if (config !== null) {
    const parsed = JSON.parse(config) as SharedHostConfig;
    configured = { provider: parsed.start.provider, cwd: parsed.start.input.cwd };
  }
  let flags: WatchFlags | null = null;
  try {
    flags = await readWatchFlags(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const failureText = await readOptional(join(root, 'supervisor', 'failure.json'));
  const failure =
    failureText === null
      ? null
      : String((JSON.parse(failureText) as { message?: unknown }).message ?? failureText);
  return { configured, flags, health: null, failure, takenOver: await readTakenOver(root) };
}

type RunningAgentHost = {
  stop: AbortController;
  done: Promise<void>;
  control: WatcherControl;
  sessions: Supervision & { close: () => Promise<void> };
};

/**
 * Runs each agent's agent host inside the controller's process, as Switch
 * Console runs its own agents' agent hosts: the shared host's `runAgentHost`,
 * fed its events by `openStream` rather than by a connection of its own, in a
 * state root of its own driven through the files it reads (`watch.json`,
 * `config.json`). Its sessions are the controller's child processes, so
 * nothing an agent runs outlives the controller.
 *
 * An agent host that fails is started again after a short wait, at most
 * `MAX_CRASHES` times in `CRASH_WINDOW_MS`; past that its failure is recorded
 * and it stays down until a new revision or an explicit restart.
 */
export class InProcessRuntime implements AgentRuntime {
  private readonly hosts = new Map<string, RunningAgentHost>();
  private readonly crashes = new Map<string, number[]>();
  private readonly links = new SessionLinks();
  private readonly lifetime = new AbortController();

  constructor(
    private readonly deps: {
      layout: DataLayout;
      /** The `shared-host-daemon.mjs` bundle from agent-providers: what each session runs. */
      bundlePath: string;
      /** The stream the agent's agent host hears its events on. */
      openStream: (agentId: string) => OpenAgentStream;
      log: Logger;
      /** How long a failed agent host waits before it is started again. */
      crashBackoffMs: number;
    }
  ) {
    assertSupportedPlatform(process.platform);
  }

  credentialsPath(agentId: string): string {
    return this.deps.layout.agentCredentials(agentId);
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    const text = await readOptional(this.credentialsPath(agentId));
    if (text === null) return null;
    try {
      const env = (JSON.parse(text) as { env?: Record<string, unknown> }).env ?? {};
      const endpoint = env.SWITCH_API_ENDPOINT;
      const token = env.SWITCH_API_TOKEN;
      if (env.SWITCH_AGENT_ID !== agentId) return null;
      return typeof endpoint === 'string' && typeof token === 'string' ? { endpoint, token } : null;
    } catch {
      return null;
    }
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    await mkdir(this.deps.layout.agentDir(agentId), { recursive: true, mode: 0o700 });
    await writeAtomic(
      this.credentialsPath(agentId),
      JSON.stringify({
        env: {
          SWITCH_API_ENDPOINT: credentials.endpoint,
          SWITCH_API_TOKEN: credentials.token,
          SWITCH_AGENT_ID: agentId,
        },
      })
    );
  }

  async deleteCredentials(agentId: string): Promise<void> {
    await removeOptional(this.credentialsPath(agentId));
  }

  async workingDirectory(name: string, directory: string | null): Promise<string> {
    if (directory === null) {
      const path = this.deps.layout.workspace(name);
      await mkdir(path, { recursive: true });
      return path;
    }
    const expanded =
      directory === '~' || directory.startsWith('~/')
        ? join(homedir(), directory.slice(1))
        : directory;
    if (!isAbsolute(expanded))
      throw new ReasonedError(
        'definition_invalid',
        `The working directory '${directory}' is not an absolute path.`
      );
    let isDirectory: boolean;
    try {
      isDirectory = (await stat(expanded)).isDirectory();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      throw new ReasonedError(
        'definition_invalid',
        `The working directory ${expanded} does not exist on this machine.`
      );
    }
    if (!isDirectory)
      throw new ReasonedError('definition_invalid', `${expanded} is not a directory.`);
    return expanded;
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const root = this.deps.layout.watcherRoot(agentId);
    const running = this.hosts.get(agentId);
    const observation = await readRoot(root);
    return {
      ...observation,
      alive: running !== undefined,
      health: running
        ? {
            ...running.control.health(),
            pid: process.pid,
            updatedAt: new Date().toISOString(),
            current: true,
          }
        : null,
    };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    await this.stopDetached(root);
    if (options.replaceIdentity) await removeOptional(join(root, 'config.json'));
    if (options.clearTakenOver) await clearTakenOver(root);
    await this.writeFlags(root, { enabled: true, spawn: true });
    this.crashes.delete(agentId);
    await this.ensure(agentId, root, template);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.writeFlags(root, { enabled: false, spawn: false });
    const running = this.hosts.get(agentId);
    if (!running) return;
    running.stop.abort();
    if (!options.wait) return;
    const stopped = await Promise.race([
      running.done.then(() => true),
      delay(STOP_TIMEOUT_MS).then(() => false),
    ]);
    if (!stopped)
      throw new Error(
        `The agent host for agent ${agentId} has not stopped ${STOP_TIMEOUT_MS / 1000} s after being turned off.`
      );
  }

  /** Stops every agent host and every session: the controller is exiting. */
  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.hosts.values()].map((running) => running.done));
  }

  /** Writes the agent host's configuration from `template` and starts it, unless it runs. */
  private async ensure(agentId: string, root: string, template: SharedHostConfig): Promise<void> {
    await ensureSharedProcess({
      root,
      config: template,
      resuming: false,
      watcher: true,
      restart: false,
      startSource: null,
      supervision: {
        links: null,
        build: IN_PROCESS_BUILD,
        start: async ({ root: prepared, configPath }) => {
          // What was written, not what was asked for: an earlier run's
          // configuration keeps its session identity.
          const written = sharedConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')));
          this.start(agentId, prepared, written);
        },
        stop: async () => {
          await this.stop(agentId, { wait: true });
        },
      },
    });
  }

  private start(agentId: string, root: string, config: SharedHostConfig): void {
    if (this.hosts.has(agentId) || this.lifetime.signal.aborted) return;
    const stop = new AbortController();
    const signal = AbortSignal.any([stop.signal, this.lifetime.signal]);
    const control = new WatcherControl();
    const sessions = inProcessSupervision(this.deps.bundlePath, this.links);
    // For `status`, which runs in another process and reads only disk.
    const stopRecording = recordWatcherHealth(root, control);
    const done = (async () => {
      try {
        await runAgentHost(
          root,
          config,
          signal,
          sessions,
          control,
          null,
          this.deps.openStream(agentId)
        );
      } finally {
        stopRecording();
        await sessions.close();
      }
    })()
      .then(
        () => {
          this.deps.log.info('Agent host stopped', { agentId });
          return false;
        },
        (error: unknown) => this.crashed(agentId, root, signal, error)
      )
      .then((again) => {
        if (this.hosts.get(agentId)?.done === done) this.hosts.delete(agentId);
        if (again) this.start(agentId, root, config);
      });
    this.hosts.set(agentId, { stop, done, control, sessions });
    this.deps.log.info('Agent host started', { agentId });
  }

  /** Whether an agent host that failed is started again. */
  private async crashed(
    agentId: string,
    root: string,
    signal: AbortSignal,
    error: unknown
  ): Promise<boolean> {
    const message = errorMessage(error);
    if (signal.aborted) {
      this.deps.log.info('Agent host stopped', { agentId, error: message });
      return false;
    }
    const now = Date.now();
    const recent = (this.crashes.get(agentId) ?? []).filter((at) => now - at < CRASH_WINDOW_MS);
    recent.push(now);
    this.crashes.set(agentId, recent);
    if (recent.length > MAX_CRASHES) {
      this.deps.log.error('Agent host failed too often; it stays down until restarted', {
        agentId,
        error: message,
      });
      await mkdir(join(root, 'supervisor'), { recursive: true, mode: 0o700 });
      await writeAtomic(join(root, 'supervisor', 'failure.json'), JSON.stringify({ message }));
      return false;
    }
    this.deps.log.warn('Agent host failed; starting it again', {
      agentId,
      error: message,
      attempt: recent.length,
    });
    await delay(this.deps.crashBackoffMs * 2 ** (recent.length - 1), undefined, {
      signal: this.lifetime.signal,
    }).catch(() => {});
    if (this.lifetime.signal.aborted) return false;
    const flags = await readWatchFlags(root).catch(() => null);
    return flags?.enabled === true;
  }

  /**
   * Stops an agent host an earlier version of the controller left running as a
   * detached process of its own, so this one can take its root.
   */
  private async stopDetached(root: string): Promise<void> {
    for (const record of OWNER_RECORDS) {
      const path = join(root, record);
      const pid = await recordedPid(path);
      if (pid === null || pid === process.pid || !(await ownsRoot(pid, root))) continue;
      this.deps.log.warn('Stopping an agent host left running by an earlier controller', {
        root,
        pid,
      });
      process.kill(pid, 'SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (alive(pid)) {
        if (Date.now() > deadline) {
          process.kill(pid, 'SIGKILL');
          break;
        }
        await delay(200);
      }
    }
  }

  async probe(provider: Provider, binaryPath: string, cwd: string): Promise<ProviderReadiness> {
    const { stdout } = await execute(
      process.execPath,
      [this.deps.bundlePath, '--probe', provider, cwd, binaryPath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: process.env }
    );
    const line = stdout.trim().split('\n').at(-1) ?? '';
    return providerReadinessSchema.parse(JSON.parse(line));
  }

  private async writeFlags(root: string, flags: WatchFlags): Promise<void> {
    await writeAtomic(join(root, WATCH_FLAGS_FILE), JSON.stringify(watchFlagsSchema.parse(flags)));
  }
}
