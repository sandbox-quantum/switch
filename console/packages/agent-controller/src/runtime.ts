import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import {
  clearTakenOver,
  type ProviderReadiness,
  providerReadinessSchema,
  readTakenOver,
  readWatchFlags,
  type SharedHostConfig,
  type TakenOver,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  type WatcherHealthFile,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers';
import { ConfigurationError, ReasonedError } from './errors';
import type { DataLayout } from './paths';
import type { Provider } from './schemas';

const execute = promisify(execFile);

/**
 * A cloud agent's `switch-agent@<id>` unit, as its machine's supervisor
 * reports it: what the systemd runtime observes instead of a watcher's
 * records. `processState` is the supervisor's (it adds `restarting`, and
 * calls a unit that hit its start limit `crashed`).
 */
export type UnitObservation = {
  installed: boolean;
  /** The launch revision whose deployment is installed. */
  revision: number | null;
  processState:
    | 'pending'
    | 'starting'
    | 'running'
    | 'stopping'
    | 'stopped'
    | 'restarting'
    | 'crashed'
    | 'failed';
  restarts: number;
  oomKills: number;
  exit: { code: number | null; signal: number | null; result: string | null } | null;
};

/** What is on disk and alive for one agent's watcher. */
export type AgentObservation = {
  /** The watcher or its supervisor is running. */
  alive: boolean;
  /** The provider and working directory its saved configuration was created with. */
  configured: { provider: string; cwd: string } | null;
  flags: WatchFlags | null;
  /** `current` is false when the process that wrote it is gone. */
  health: (WatcherHealthFile & { current: boolean }) | null;
  /** `supervisor/failure.json`: why the watcher stopped and was not restarted. */
  failure: string | null;
  takenOver: TakenOver | null;
  /** The agent's unit, for a runtime that runs each agent in one; null otherwise. */
  unit: UnitObservation | null;
};

/** What an agent with no watcher root at all looks like. */
export function emptyObservation(): AgentObservation {
  return {
    alive: false,
    configured: null,
    flags: null,
    health: null,
    failure: null,
    takenOver: null,
    unit: null,
  };
}

export type LaunchOptions = {
  spawn: boolean;
  /** Stop a running watcher first, so the new configuration takes effect. */
  restart: boolean;
  /** Restart into a different provider or working directory: the saved configuration goes. */
  replaceIdentity: boolean;
  /** Someone asked for this watcher on purpose: a standing-down marker is cleared. */
  clearTakenOver: boolean;
};

/**
 * How the controller runs agents. `SharedHostRuntime` is the real one; tests
 * substitute a fake.
 */
/** What an agent's watcher reads to reach Switch: the controller's relay, and a token for it. */
export type RelayCredentials = { endpoint: string; token: string };

/**
 * What a cloud agent's machine supervisor builds the agent's deployment from:
 * the hosted block of its assignment, the agent's identity and desired state,
 * and the relay credentials its worker reaches Switch with. The supervisor
 * validates every field and derives every path itself.
 */
export type HostedDeploymentRequest = {
  launch_id: string;
  agent_id: string;
  name: string;
  revision: number;
  desired_state: 'running' | 'stopped';
  provider: string;
  provider_credential_kind: string | null;
  worker_capability: string;
  switch_credentials: {
    env: { SWITCH_API_ENDPOINT: string; SWITCH_API_TOKEN: string; SWITCH_AGENT_ID: string };
  };
  repository: string | null;
  spec: Record<string, unknown>;
  skills: Record<string, unknown>[];
};

/**
 * `shared-host`: each agent is a room watcher this controller launches
 * itself. `systemd`: a cloud machine's controller, where each agent is a
 * `switch-agent@<id>` unit the machine's root supervisor installs and runs
 * on request.
 */
export type RuntimeKind = 'shared-host' | 'systemd';

export interface AgentRuntime {
  readonly kind: RuntimeKind;
  observe(agentId: string): Promise<AgentObservation>;
  credentialsPath(agentId: string): string;
  /** The credentials file as written, or null when there is none or it cannot be read. */
  readCredentials(agentId: string): Promise<RelayCredentials | null>;
  writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void>;
  deleteCredentials(agentId: string): Promise<void>;
  /** `directory` from the definition, or a workspace under the data directory. */
  workingDirectory(name: string, directory: string | null): Promise<string>;
  launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void>;
  /** Installs a cloud agent's deployment and starts or stops its unit as it says. */
  launchHosted(
    agentId: string,
    deployment: HostedDeploymentRequest,
    options: { restart: boolean }
  ): Promise<void>;
  /** Turns the watcher off; with `wait`, returns once it and its sessions are gone. */
  stop(agentId: string, options: { wait: boolean }): Promise<void>;
  /** The agent is no longer assigned here: it is stopped, and what it ran from goes. */
  remove(agentId: string): Promise<void>;
  /**
   * These are all the agents assigned here: anything else this machine still
   * holds goes. Only a cloud machine holds agents beyond what this
   * controller's own records name (its disk outlives the controller).
   */
  prune(keep: string[]): Promise<void>;
  probe(provider: Provider, binaryPath: string, cwd: string): Promise<ProviderReadiness>;
}

/** An agent's relay credentials file, in the layout the shared host reads, or null. */
export async function readRelayCredentials(
  path: string,
  agentId: string
): Promise<RelayCredentials | null> {
  const text = await readOptional(path);
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

export async function writeRelayCredentials(
  directory: string,
  path: string,
  agentId: string,
  credentials: RelayCredentials
): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeAtomic(
    path,
    JSON.stringify({
      env: {
        SWITCH_API_ENDPOINT: credentials.endpoint,
        SWITCH_API_TOKEN: credentials.token,
        SWITCH_AGENT_ID: agentId,
      },
    })
  );
}

export async function removeOptional(path: string): Promise<void> {
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}

/** How long a watcher asked to stop is given; its supervisor allows its own children 10 s. */
const STOP_TIMEOUT_MS = 30_000;
const LAUNCH_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 90_000;

async function writeAtomic(path: string, body: string): Promise<void> {
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** A saved PID counts only while it still names a process started for this root. */
async function ownsRoot(pid: number, root: string): Promise<boolean> {
  if (!alive(pid)) return false;
  try {
    const { stdout } = await execute('ps', ['-p', String(pid), '-o', 'command=']);
    return stdout.includes(root);
  } catch (error) {
    if ((error as { code?: number }).code === 1) return false;
    throw error;
  }
}

async function recordedPid(path: string): Promise<number | null> {
  const text = await readOptional(path);
  if (text === null) return null;
  const pid = (JSON.parse(text) as { pid?: unknown }).pid;
  return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

/** The owner records a watcher writes under its root: the worker's, then its supervisor's. */
const OWNER_RECORDS = ['shared-owner.lock', join('supervisor', 'owner.json')];

/** The shared host needs POSIX process control: macOS or Linux. */
export function assertSupportedPlatform(platform: NodeJS.Platform): void {
  if (platform === 'win32')
    throw new ConfigurationError(
      'The agents controller runs agents through the shared host, which needs a macOS or Linux machine.'
    );
}

/**
 * Runs each agent as Console runs a remote one: a detached room watcher from
 * the agent-providers shared-host bundle, in a state root of its own, driven
 * through the files it reads (`watch.json`, `config.json`) and observed
 * through the files it writes (`health.json`, `supervisor/failure.json`).
 *
 * A restart is a stop and a start: the watcher is turned off, waited out, and
 * launched again from the new template. The bundle's own `--restart` mode is
 * not used because it relaunches the root as a session host, not a watcher.
 */
export class SharedHostRuntime implements AgentRuntime {
  readonly kind = 'shared-host';

  constructor(
    private readonly deps: {
      layout: DataLayout;
      /** The `shared-host-daemon.mjs` bundle from agent-providers. */
      bundlePath: string;
    }
  ) {
    assertSupportedPlatform(process.platform);
  }

  credentialsPath(agentId: string): string {
    return this.deps.layout.agentCredentials(agentId);
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    return readRelayCredentials(this.credentialsPath(agentId), agentId);
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    await writeRelayCredentials(
      this.deps.layout.agentDir(agentId),
      this.credentialsPath(agentId),
      agentId,
      credentials
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
    let living = false;
    for (const record of OWNER_RECORDS) {
      const pid = await recordedPid(join(root, record));
      if (pid !== null && (await ownsRoot(pid, root))) living = true;
    }
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
    const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
    let health: AgentObservation['health'] = null;
    if (healthText !== null) {
      const parsed = watcherHealthFileSchema.parse(JSON.parse(healthText));
      health = { ...parsed, current: await ownsRoot(parsed.pid, root) };
    }
    const failureText = await readOptional(join(root, 'supervisor', 'failure.json'));
    const failure =
      failureText === null
        ? null
        : String((JSON.parse(failureText) as { message?: unknown }).message ?? failureText);
    return {
      alive: living,
      configured,
      flags,
      health,
      failure,
      takenOver: await readTakenOver(root),
      unit: null,
    };
  }

  async launchHosted(): Promise<void> {
    throw new ReasonedError(
      'definition_invalid',
      'This is a cloud agent; only the agents controller of its cloud machine runs it.'
    );
  }

  async remove(agentId: string): Promise<void> {
    await this.stop(agentId, { wait: false });
  }

  async prune(): Promise<void> {}

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    if (options.replaceIdentity) await removeOptional(join(root, 'config.json'));
    if (options.clearTakenOver) await clearTakenOver(root);
    await this.writeFlags(root, { enabled: true, spawn: options.spawn });
    const templatePath = join(root, 'template.json');
    await writeAtomic(templatePath, JSON.stringify(template));
    await this.runBundle([root, templatePath, '--ensure-watch', 'false'], LAUNCH_TIMEOUT_MS);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    const root = this.deps.layout.watcherRoot(agentId);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await this.writeFlags(root, { enabled: false, spawn: false });
    if (!options.wait) return;
    const deadline = Date.now() + STOP_TIMEOUT_MS;
    for (;;) {
      let running = false;
      for (const record of OWNER_RECORDS) {
        const pid = await recordedPid(join(root, record));
        if (pid !== null && (await ownsRoot(pid, root))) running = true;
      }
      if (!running) return;
      if (Date.now() > deadline)
        throw new Error(
          `The watcher for agent ${agentId} has not stopped ${STOP_TIMEOUT_MS / 1000} s after being turned off; see ${join(root, 'supervisor', 'worker.log')}.`
        );
      await delay(200);
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

  private async runBundle(args: string[], timeoutMs: number): Promise<string> {
    const child = spawn(process.execPath, [this.deps.bundlePath, ...args], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (exitCode) => resolve(exitCode));
      });
      if (code !== 0)
        throw new Error(
          `The shared host launcher failed (exit ${code ?? 'signal'}): ${(stderr || stdout).trim().slice(-2000)}`
        );
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}
