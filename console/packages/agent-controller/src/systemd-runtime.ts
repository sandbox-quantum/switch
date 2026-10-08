import { execFile } from 'node:child_process';
import { chmod, chown, lstat, mkdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  clearTakenOver,
  controlledEnvironment,
  HOSTED_WORKSPACE_FILE,
  hostedWorkspaceSchema,
  type ProviderReadiness,
  type SharedHostConfig,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers';
import { z } from 'zod';
import type { LoginRevision } from './ec2/sealed-logins';
import { ReasonedError } from './errors';
import { errorMessage, type Logger } from './log';
import type { Ec2Layout } from './paths';
import {
  type AgentObservation,
  type AgentRuntime,
  type LaunchOptions,
  parseRelayCredentials,
  readOptional,
  readRoot,
  type RelayCredentials,
  relayCredentialsBody,
  removeOptional,
  writeAtomic,
} from './runtime';
import type { Provider } from './schemas';

/** `systemctl` with `args`, answering its standard output; a non-zero exit throws. */
export type Systemctl = (args: string[]) => Promise<string>;

const execute = promisify(execFile);
const SYSTEMCTL_TIMEOUT_MS = 60_000;

/** The real `systemctl`, never through a shell, never prompting for a password. */
export const systemctl: Systemctl = async (args) => {
  const { stdout } = await execute('systemctl', ['--no-ask-password', ...args], {
    timeout: SYSTEMCTL_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

/** The provider logins an agent unit loads; see `SealedLogins`. */
export interface UnitLogins {
  materialize(agentId: string, provider: Provider): Promise<void>;
  remove(agentId: string): Promise<void>;
  removeNative(agentId: string, provider: Provider): Promise<void>;
  readiness(provider: Provider): Promise<ProviderReadiness>;
  onRevision(listener: (change: LoginRevision) => void): () => void;
}

const SHOW_PROPERTIES = [
  'ActiveState',
  'SubState',
  'Result',
  'NRestarts',
  'InvocationID',
  'ActiveEnterTimestampMonotonic',
];
const LIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);
const RESTART_WINDOW_MS = 10 * 60 * 1000;
/**
 * Setgid, so what agents create keeps their group; sticky, so an agent can
 * never rename or replace an entry the controller owns (its `watcher/`, the
 * files the controller writes) with a link to somewhere else.
 */
const SHARED_DIR_MODE = 0o3770;
const SHARED_FILE_MODE = 0o640;

/** What an agent host may add to its health file: whether it has work in hand. */
const unitHealthSchema = watcherHealthFileSchema.extend({
  busy: z.boolean().optional(),
  lastActivityAt: z.string().nullable().optional(),
});

type UnitState = {
  activeState: string;
  result: string;
  restarts: number;
  invocationId: string;
};

type PendingRestart = { provider: Provider; connected: boolean; since: number };

/**
 * Runs each agent as an instance of the `switch-agent@.service` template unit
 * on a cloud machine, as the `switch-agent` user, with systemd its
 * supervisor. The controller writes what the unit runs from: the agent
 * host's `config.json` (rewritten whole on every launch, never read back to
 * decide what runs), `workspace.json`, and the relay and provider login files
 * the unit loads as credentials. It starts and stops the unit through
 * `systemctl`, which polkit allows it for these units only.
 *
 * Everything under an agent's root may be written by the agent, so it is
 * read as untrusted: never through a symbolic link, never past a size limit,
 * always schema-checked; and nothing in it is ever run.
 */
export class SystemdRuntime implements AgentRuntime {
  private readonly units = new Map<
    string,
    { restarts: number; at: number[]; oomKills: number; result: string }
  >();
  private readonly pending = new Map<string, PendingRestart>();
  private readonly timer: NodeJS.Timeout;
  private readonly unsubscribe: () => void;
  private acting: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      layout: Ec2Layout;
      systemctl: Systemctl;
      logins: UnitLogins;
      /** The `switch-agent` group, which the agent units run as. */
      agentGroupId: number;
      log: Logger;
      now: () => number;
      /** How often agents waiting on a new login are checked for being idle. */
      idleCheckMs: number;
      /** How long an agent waiting on a new login is let finish before it is restarted anyway. */
      forceRestartAfterMs: number;
    }
  ) {
    this.unsubscribe = deps.logins.onRevision((change) => this.queue(change));
    this.timer = setInterval(() => {
      this.acting = this.acting.then(() => this.actOnPending());
    }, deps.idleCheckMs);
    this.timer.unref();
  }

  watcherRoot(agentId: string): string {
    return this.deps.layout.watcherRoot(agentId);
  }

  credentialsPath(agentId: string): string {
    return this.deps.layout.unitCredentialsPath(agentId);
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    const text = await readOptional(this.deps.layout.credentialsFile(agentId));
    return text === null ? null : parseRelayCredentials(text, agentId);
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    await mkdir(this.deps.layout.runDir, { recursive: true, mode: 0o700 });
    await writeAtomic(
      this.deps.layout.credentialsFile(agentId),
      relayCredentialsBody(agentId, credentials)
    );
  }

  /** Forgets an agent: its unit's failed state and the files it loads. Its data stays. */
  async deleteCredentials(agentId: string): Promise<void> {
    const unit = this.deps.layout.unit(agentId);
    this.pending.delete(agentId);
    await removeOptional(this.deps.layout.credentialsFile(agentId));
    await this.deps.logins.remove(agentId);
    if ((await this.show(agentId)).activeState === 'failed')
      await this.deps.systemctl(['reset-failed', unit]);
    this.units.delete(agentId);
  }

  /**
   * The definition's directory, which must be inside the agents' worktrees or
   * roots: an agent unit sees only its own. A definition naming none has no
   * agent id here to place one by, so it cannot run on a cloud machine.
   */
  async workingDirectory(name: string, directory: string | null): Promise<string> {
    if (directory === null)
      throw new ReasonedError(
        'definition_invalid',
        `Agent ${name} names no working directory; on a cloud machine it needs one under ${this.deps.layout.worktreesRoot}.`
      );
    if (!isAbsolute(directory))
      throw new ReasonedError(
        'definition_invalid',
        `The working directory '${directory}' is not an absolute path.`
      );
    const resolved = resolve(directory);
    if (
      !within(this.deps.layout.worktreesRoot, resolved) &&
      !within(this.deps.layout.agentsRoot, resolved)
    )
      throw new ReasonedError(
        'definition_invalid',
        `The working directory '${directory}' is outside ${this.deps.layout.worktreesRoot} and ${this.deps.layout.agentsRoot}.`
      );
    return resolved;
  }

  probe(provider: Provider): Promise<ProviderReadiness> {
    return this.deps.logins.readiness(provider);
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const unit = await this.show(agentId);
    const alive = LIVE_STATES.has(unit.activeState);
    const root = this.deps.layout.watcherRoot(agentId);
    const state = await readRoot(root);
    const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
    let health: AgentObservation['health'] = null;
    let activity: AgentObservation['activity'] = null;
    if (healthText !== null) {
      const parsed = unitHealthSchema.safeParse(parseJson(healthText));
      if (parsed.success) {
        const current =
          alive && unit.invocationId !== '' && parsed.data.invocation === unit.invocationId;
        const { busy, lastActivityAt, ...rest } = parsed.data;
        health = { ...rest, current };
        if (current && busy !== undefined)
          activity = { busy, lastActivityAt: lastActivityAt ?? null };
      } else
        this.deps.log.warn('An agent host’s health file is not one; ignoring it', {
          agentId,
          error: parsed.error.message,
        });
    }
    const failure =
      state.failure ??
      (unit.activeState === 'failed' ? `The agent unit failed (${unit.result}).` : null);
    return {
      ...state,
      alive,
      health,
      failure,
      activity,
      unit: this.count(agentId, unit),
    };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const { layout } = this.deps;
    const unit = layout.unit(agentId);
    const agentRoot = layout.agentRoot(agentId);
    const watcherRoot = layout.watcherRoot(agentId);
    const cwd = resolve(template.start.input.cwd);
    if (!within(agentRoot, cwd) && !within(layout.worktreeRoot(agentId), cwd))
      throw new ReasonedError(
        'definition_invalid',
        `Agent ${agentId} would work in ${cwd}, outside its own root and worktrees.`
      );
    if (template.execution?.credentialsPath !== layout.unitCredentialsPath(agentId))
      throw new Error(
        `The launch configuration for agent ${agentId} does not read the credentials its unit loads.`
      );
    if (!template.execution.binaryPath)
      throw new Error(
        `The launch configuration for agent ${agentId} names no provider executable.`
      );

    await mkdir(layout.agentsRoot, { recursive: true, mode: 0o750 });
    await mkdir(layout.worktreesRoot, { recursive: true, mode: 0o750 });
    await this.sharedDirectory(agentRoot);
    await this.sharedDirectory(watcherRoot);
    await this.sharedDirectory(layout.worktreeRoot(agentId));

    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    if (options.clearTakenOver) await clearTakenOver(watcherRoot);
    const provider = template.start.provider;
    await this.deps.logins.materialize(agentId, provider);

    const config: SharedHostConfig = structuredClone(template);
    config.start.input.env = {
      ...config.start.input.env,
      ...controlledEnvironment(agentRoot, provider),
    };
    const workspace = hostedWorkspaceSchema.parse({
      connections: options.connections,
      workspacePath: cwd,
      skills: options.skills,
      instructions: '',
    });
    const workspacePath = join(agentRoot, HOSTED_WORKSPACE_FILE);
    const previousWorkspace = await readOptional(workspacePath);
    await this.writeShared(workspacePath, JSON.stringify(workspace));
    await this.writeFlags(watcherRoot, { enabled: true, spawn: true });
    await this.writeShared(join(watcherRoot, 'template.json'), JSON.stringify(template));
    await this.writeShared(join(watcherRoot, 'config.json'), JSON.stringify(config));
    this.pending.delete(agentId);
    // A unit reads its workspace only as it starts: its preparation installs
    // the skills and the `gh` wrapper, and its watcher hands its sessions the
    // GitHub environment of the connections granted then.
    const workspaceChanged =
      previousWorkspace !== null && previousWorkspace !== JSON.stringify(workspace);
    await this.deps.systemctl([workspaceChanged ? 'restart' : 'start', unit]);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    const unit = this.deps.layout.unit(agentId);
    const watcherRoot = this.deps.layout.watcherRoot(agentId);
    this.pending.delete(agentId);
    if (await isDirectory(watcherRoot))
      await this.writeFlags(watcherRoot, { enabled: false, spawn: false });
    await this.deps.systemctl(options.wait ? ['stop', unit] : ['--no-block', 'stop', unit]);
  }

  /** Agent units outlive the controller; only the controller's own timer stops. */
  async close(): Promise<void> {
    clearInterval(this.timer);
    this.unsubscribe();
    await this.acting;
  }

  private queue(change: LoginRevision): void {
    for (const agentId of change.agentIds) {
      const since = this.pending.get(agentId)?.since ?? this.deps.now();
      this.pending.set(agentId, { provider: change.provider, connected: change.connected, since });
    }
  }

  /**
   * Restarts each agent waiting on a new login once it says it is idle, or
   * once it has been let finish for long enough; stops one whose login was
   * withdrawn the same way.
   */
  private async actOnPending(): Promise<void> {
    for (const [agentId, pending] of [...this.pending]) {
      try {
        const observation = await this.observe(agentId);
        const overdue = this.deps.now() - pending.since >= this.deps.forceRestartAfterMs;
        if (observation.alive && observation.activity?.busy !== false && !overdue) continue;
        this.pending.delete(agentId);
        if (!observation.alive) continue;
        const unit = this.deps.layout.unit(agentId);
        this.deps.log.info(
          pending.connected
            ? 'Restarting an agent for its provider’s new login'
            : 'Stopping an agent whose provider login was disconnected',
          { agentId, forced: overdue }
        );
        await this.deps.systemctl([pending.connected ? 'restart' : 'stop', unit]);
        if (!pending.connected) await this.deps.logins.removeNative(agentId, pending.provider);
      } catch (error) {
        this.deps.log.error('Could not apply a provider login change to an agent', {
          agentId,
          error: errorMessage(error),
        });
      }
    }
  }

  private async show(agentId: string): Promise<UnitState> {
    const stdout = await this.deps.systemctl([
      'show',
      this.deps.layout.unit(agentId),
      `--property=${SHOW_PROPERTIES.join(',')}`,
    ]);
    const values = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const activeState = values.get('ActiveState');
    if (!activeState)
      throw new Error(`systemctl show did not report the state of agent ${agentId}'s unit.`);
    return {
      activeState,
      result: values.get('Result') ?? '',
      restarts: Number(values.get('NRestarts') ?? 0) || 0,
      invocationId: values.get('InvocationID') ?? '',
    };
  }

  /** Restarts systemd made in the last ten minutes, and OOM kills, seen since this controller started. */
  private count(agentId: string, unit: UnitState): NonNullable<AgentObservation['unit']> {
    const now = this.deps.now();
    let entry = this.units.get(agentId);
    if (!entry) {
      entry = { restarts: unit.restarts, at: [], oomKills: 0, result: unit.result };
      this.units.set(agentId, entry);
    } else {
      if (unit.restarts > entry.restarts)
        for (let i = entry.restarts; i < unit.restarts; i++) entry.at.push(now);
      if (
        unit.result === 'oom-kill' &&
        (entry.result !== 'oom-kill' || unit.restarts > entry.restarts)
      )
        entry.oomKills += 1;
      entry.restarts = unit.restarts;
      entry.result = unit.result;
    }
    entry.at = entry.at.filter((at) => now - at < RESTART_WINDOW_MS);
    return { restarts10m: entry.at.length, oomKills: entry.oomKills };
  }

  /**
   * A directory the agent unit writes in: made when missing, refused when it
   * is a link or not this controller's, and given to the agents' group with
   * the setgid bit, which `mkdir` and the controller's umask would drop.
   */
  private async sharedDirectory(path: string): Promise<void> {
    try {
      await mkdir(path, { mode: SHARED_DIR_MODE });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`${path} is not a directory; an agent's directories are never followed.`);
    if (process.getuid && info.uid !== process.getuid())
      throw new Error(`${path} is not owned by the controller's user.`);
    if (info.gid !== this.deps.agentGroupId) await chown(path, -1, this.deps.agentGroupId);
    if ((info.mode & 0o7777) !== SHARED_DIR_MODE) await chmod(path, SHARED_DIR_MODE);
  }

  private writeShared(path: string, body: string): Promise<void> {
    return writeAtomic(path, body, { mode: SHARED_FILE_MODE, gid: this.deps.agentGroupId });
  }

  private writeFlags(root: string, flags: WatchFlags): Promise<void> {
    return this.writeShared(
      join(root, WATCH_FLAGS_FILE),
      JSON.stringify(watchFlagsSchema.parse(flags))
    );
  }
}

function within(root: string, path: string): boolean {
  const offset = relative(root, path);
  return (
    offset === '' || (!offset.startsWith(`..${sep}`) && offset !== '..' && !isAbsolute(offset))
  );
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
