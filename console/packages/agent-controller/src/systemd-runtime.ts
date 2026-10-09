import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  AGENT_ENV_VARS,
  clearTakenOver,
  type ProviderReadiness,
  type SharedHostConfig,
  sharedConfigSchema,
  WATCH_FLAGS_FILE,
  WATCHER_HEALTH_FILE,
  type WatchFlags,
  watcherHealthFileSchema,
  watchFlagsSchema,
} from '@switch-console/agent-providers';
import { ReasonedError } from './errors';
import type { Logger } from './log';
import {
  type AgentObservation,
  type AgentRuntime,
  emptyObservation,
  isInside,
  type LaunchOptions,
  loginProbeEnvironment,
  parseRelayCredentials,
  probeProvider,
  readOptional,
  readRoot,
  type RelayCredentials,
  relayCredentialsBody,
  removeOptional,
  writeAtomic,
} from './runtime';
import type { Provider } from './schemas';
import type { GivenLogin } from './sealed-logins';
import {
  agentRoot,
  homeRootOf,
  type SeparateUsersConfig,
  separateUserNames,
  unitAgentRoot,
  unitCredentialsPath,
  unitFilesDir,
} from './separate-users';
import type { ControllerStore } from './store';

/** `systemctl` with `args`, answering its standard output; a non-zero exit throws. */
export type Systemctl = (args: string[]) => Promise<string>;

const execute = promisify(execFile);

/** The system manager's `systemctl`, never through a shell, never asking for a password. */
export const systemctl: Systemctl = async (args) => {
  const { stdout } = await execute('systemctl', ['--no-ask-password', ...args], {
    timeout: 60_000,
    maxBuffer: 1024 * 1024,
  });
  return stdout;
};

const LIVE_STATES = new Set(['active', 'activating', 'deactivating', 'reloading']);
/**
 * Sticky, so an agent can never rename or remove what the controller wrote in
 * its directories (its configuration, its watch flags); group-writable, so it
 * can write its own beside them.
 */
const CONTROLLED_DIR_MODE = 0o1770;
/** The agent's home and workspace: entirely the agent's to write in. */
const AGENT_DIR_MODE = 0o770;
const SHARED_FILE_MODE = 0o640;
/** In each agent's directory: which agent it holds, so a reused agent user never runs in another's. */
const AGENT_MARKER = '.switch-agent-id';
/** Under the agents' directory: the directories of agents this controller no longer runs. */
const RELEASED = 'released';
/** Provider settings naming a path in the controller user's home, which an agent could not reach. */
const PATH_VARIABLES = new Set([
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'CLOUDSDK_CONFIG',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_PROFILE',
]);

type UnitState = { activeState: string; result: string; mainPid: number };

/**
 * Runs each agent as a Linux user of its own (see `separate-users.ts`): the
 * agent claims a free user from the pool set up for this controller, and runs
 * as that user's instance of the agents' template unit, with systemd its
 * supervisor. The controller writes what the unit starts from, the agent
 * host's `config.json` and `watch.json` in its directory and the relay
 * credentials and environment it loads, and starts and stops the unit through
 * `systemctl`, which polkit allows it for these units only. The agent host
 * hears its events on the controller's hub, as one in a process of its own
 * does, and outlives the controller.
 *
 * Everything an agent writes is read as untrusted: through no link, parsed
 * against its schema, and never run.
 */
export class SystemdRuntime implements AgentRuntime {
  private readonly names: ReturnType<typeof separateUserNames>;

  constructor(
    private readonly deps: {
      config: SeparateUsersConfig;
      store: ControllerStore;
      systemctl: Systemctl;
      /** The controller's own environment: the provider settings its agents get come from it. */
      env: NodeJS.ProcessEnv;
      log: Logger;
      now: () => number;
    }
  ) {
    this.names = separateUserNames(deps.config.uid);
  }

  /** The agent user the agent runs as, claimed now when it holds none. */
  private claim(agentId: string): number {
    const { config, store } = this.deps;
    const slot = store.claimAgentUser(
      agentId,
      config.agentUsers,
      new Date(this.deps.now()).toISOString()
    );
    if (slot === null)
      throw new ReasonedError(
        'capacity_exceeded',
        `Every one of the ${config.agentUsers} agent users set up on this machine runs an agent. Run the setup again with a larger --agent-users.`
      );
    return slot;
  }

  credentialsPath(agentId: string): string {
    return unitCredentialsPath(this.deps.config, this.claim(agentId));
  }

  async readCredentials(agentId: string): Promise<RelayCredentials | null> {
    const slot = this.deps.store.agentUser(agentId);
    if (slot === null) return null;
    const text = await readOptional(join(unitFilesDir(this.deps.config, slot), 'relay.json'));
    return text === null ? null : parseRelayCredentials(text, agentId);
  }

  async writeCredentials(agentId: string, credentials: RelayCredentials): Promise<void> {
    const directory = unitFilesDir(this.deps.config, this.claim(agentId));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(join(directory, 'relay.json'), relayCredentialsBody(agentId, credentials));
  }

  /**
   * Forgets an agent: its unit is stopped, the files it loaded removed, its
   * directory set aside under `released/` (to come back if the agent is given
   * to this controller again), and its agent user freed.
   */
  async deleteCredentials(agentId: string): Promise<void> {
    const slot = this.deps.store.agentUser(agentId);
    if (slot === null) return;
    const unit = this.names.agentUnit(slot);
    await this.deps.systemctl(['stop', unit]);
    if ((await this.show(unit)).activeState === 'failed')
      await this.deps.systemctl(['reset-failed', unit]);
    await rm(unitFilesDir(this.deps.config, slot), { recursive: true, force: true });
    const root = agentRoot(this.deps.config, slot);
    if (await isDirectory(root)) await this.setAside(root, agentId);
    this.deps.store.releaseAgentUser(agentId);
  }

  /**
   * The definition's directory, as the agent sees it, which must be inside
   * its own directory, the only one its unit can see; a `workspace` there
   * when it names none.
   */
  async workingDirectory(agentId: string, name: string, directory: string | null): Promise<string> {
    const onMachine = await this.prepare(agentId);
    const seen = unitAgentRoot(this.deps.config);
    if (directory === null) return join(seen, 'workspace');
    if (!isAbsolute(directory))
      throw new ReasonedError(
        'definition_invalid',
        `The working directory '${directory}' is not an absolute path.`
      );
    const resolved = resolve(directory);
    if (resolved !== seen && !isInside(seen, resolved))
      throw new ReasonedError(
        'definition_invalid',
        `Agent ${name} would work in ${resolved}, but this machine runs each agent as a user of its own that sees only its own directory, at ${seen}. Leave the directory empty, or name one inside it.`
      );
    let path = onMachine;
    for (const part of relative(seen, resolved).split(sep).filter(Boolean)) {
      path = join(path, part);
      if (await isDirectory(path)) continue;
      await this.controlledDirectory(path, AGENT_DIR_MODE);
    }
    return resolved;
  }

  /**
   * The provider's login as an agent would have it: only the provider
   * settings it is given, or `login`, and a home of its own.
   */
  async probe(
    provider: Provider,
    binaryPath: string,
    cwd: string,
    login: GivenLogin | null
  ): Promise<ProviderReadiness> {
    const home = homeRootOf(binaryPath, []);
    if (home)
      return {
        status: 'unconfigured',
        message: `${binaryPath} is under ${home}, which agents running as users of their own cannot reach. Install the ${provider} CLI system-wide.`,
        models: [],
      };
    const probeHome = join(this.deps.config.dataDir, 'probe-home');
    await mkdir(probeHome, { recursive: true, mode: 0o700 });
    const given = login
      ? await loginProbeEnvironment(
          join(this.deps.config.dataDir, 'login-check', provider),
          login,
          binaryPath
        )
      : {};
    return probeProvider(this.deps.config.bundle, provider, binaryPath, cwd, {
      ...this.agentEnvironment(),
      PATH: this.deps.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
      HOME: probeHome,
      ...given,
    });
  }

  agentStateRoot(_agentId: string): string {
    return join(unitAgentRoot(this.deps.config), 'watcher');
  }

  async observe(agentId: string): Promise<AgentObservation> {
    const slot = this.deps.store.agentUser(agentId);
    if (slot === null) return emptyObservation();
    const unit = this.names.agentUnit(slot);
    const state = await this.show(unit);
    const alive = LIVE_STATES.has(state.activeState);
    const root = join(agentRoot(this.deps.config, slot), 'watcher');
    if (!(await isDirectory(root))) return { ...emptyObservation(), alive };
    const onDisk = await readRoot(root);
    let health: AgentObservation['health'] = null;
    const healthText = await readOptional(join(root, WATCHER_HEALTH_FILE));
    if (healthText !== null) {
      const parsed = watcherHealthFileSchema.safeParse(parseJson(healthText));
      if (parsed.success)
        health = { ...parsed.data, current: alive && parsed.data.pid === state.mainPid };
      else
        this.deps.log.warn('An agent’s health file is not one; ignoring it', {
          agentId,
          error: parsed.error.message,
        });
    }
    const failure =
      onDisk.failure ??
      (state.activeState === 'failed'
        ? `The agent's unit ${unit} failed (${state.result}); see journalctl -u ${unit}.`
        : null);
    return { ...onDisk, alive, health, failure };
  }

  async launch(agentId: string, template: SharedHostConfig, options: LaunchOptions): Promise<void> {
    const slot = this.claim(agentId);
    const unit = this.names.agentUnit(slot);
    const watcher = join(await this.prepare(agentId), 'watcher');
    const seen = unitAgentRoot(this.deps.config);
    const cwd = resolve(template.start.input.cwd);
    if (cwd !== seen && !isInside(seen, cwd))
      throw new ReasonedError(
        'definition_invalid',
        `Agent ${agentId} would work in ${cwd}, outside ${seen}, the only directory its user sees.`
      );
    if (template.execution?.credentialsPath !== unitCredentialsPath(this.deps.config, slot))
      throw new Error(
        `The launch configuration for agent ${agentId} does not read the credentials its unit loads.`
      );
    const binaryPath = template.execution.binaryPath;
    if (!binaryPath)
      throw new Error(`The launch configuration for agent ${agentId} names no provider CLI.`);
    const home = homeRootOf(binaryPath, []);
    if (home)
      throw new ReasonedError(
        'provider_not_installed',
        `${binaryPath} is under ${home}, which agents running as users of their own cannot reach. Install the ${template.start.provider} CLI system-wide.`
      );

    if (options.restart || options.replaceIdentity) await this.stop(agentId, { wait: true });
    if (options.replaceIdentity) await removeOptional(join(watcher, 'config.json'));
    if (options.clearTakenOver) await clearTakenOver(watcher);
    await this.writeEnvironment(slot);
    await this.writeConfig(watcher, template);
    await this.writeFlags(watcher, { enabled: true, spawn: true });
    const state = await this.show(unit);
    // A running agent host reads its new configuration itself.
    if (LIVE_STATES.has(state.activeState)) return;
    await rm(join(watcher, 'supervisor', 'failure.json'), { force: true });
    if (state.activeState === 'failed') await this.deps.systemctl(['reset-failed', unit]);
    await this.deps.systemctl(['start', unit]);
  }

  async stop(agentId: string, options: { wait: boolean }): Promise<void> {
    const slot = this.deps.store.agentUser(agentId);
    if (slot === null) return;
    const watcher = join(agentRoot(this.deps.config, slot), 'watcher');
    if (await isDirectory(watcher))
      await this.writeFlags(watcher, { enabled: false, spawn: false });
    const unit = this.names.agentUnit(slot);
    await this.deps.systemctl(options.wait ? ['stop', unit] : ['--no-block', 'stop', unit]);
  }

  /** Agent units outlive the controller. */
  async close(): Promise<void> {}

  /**
   * The agent's directory, ready for its unit: the one it had under
   * `released/` if it ran here before, another agent's set aside if its user
   * held one, and the directories the agent host and the agent write in.
   */
  private async prepare(agentId: string): Promise<string> {
    const slot = this.claim(agentId);
    const root = agentRoot(this.deps.config, slot);
    if (await isDirectory(root)) {
      const holder = (await readOptional(join(root, AGENT_MARKER)))?.trim() ?? '';
      if (holder !== agentId) await this.setAside(root, holder || `unknown-${this.deps.now()}`);
    }
    if (!(await isDirectory(root))) {
      const released = join(this.deps.config.agentsDir, RELEASED, agentId);
      if (await isDirectory(released)) {
        await rename(released, root);
        this.deps.log.info('Gave an agent back the directory it had here before', {
          agentId,
          directory: root,
        });
      }
    }
    await this.controlledDirectory(root, CONTROLLED_DIR_MODE);
    await this.writeShared(join(root, AGENT_MARKER), `${agentId}\n`);
    await this.controlledDirectory(join(root, 'watcher'), CONTROLLED_DIR_MODE);
    await this.controlledDirectory(join(root, 'home'), AGENT_DIR_MODE);
    await this.controlledDirectory(join(root, 'workspace'), AGENT_DIR_MODE);
    return root;
  }

  /** Moves an agent's directory to `released/<agentId>`, moving aside one already there. */
  private async setAside(root: string, agentId: string): Promise<void> {
    const released = join(this.deps.config.agentsDir, RELEASED);
    await mkdir(released, { recursive: true, mode: 0o700 });
    const target = join(released, agentId);
    if (await isDirectory(target)) await rename(target, `${target}.${this.deps.now()}`);
    await rename(root, target);
    this.deps.log.info('Set an agent’s directory aside', { agentId, directory: target });
  }

  /**
   * A directory the controller owns and the agents' group may use: made when
   * missing, refused when it is a link or someone else's, and given the group
   * and mode the controller's umask would not.
   */
  private async controlledDirectory(path: string, mode: number): Promise<void> {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`${path} is not a directory; an agent's directories are never followed.`);
    if (info.uid !== this.deps.config.uid)
      throw new Error(`${path} is not owned by the controller's user.`);
    if (info.gid !== this.deps.config.gid) {
      const handle = await open(path, 'r');
      try {
        await handle.chown(-1, this.deps.config.gid);
      } finally {
        await handle.close();
      }
    }
    if ((info.mode & 0o7777) !== mode) await chmod(path, mode);
  }

  /** Writes a file the agent reads: whole, owned by the controller, readable by the agents' group. */
  private async writeShared(path: string, body: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}`;
    const file = await open(temporary, 'wx', SHARED_FILE_MODE);
    try {
      await file.chown(-1, this.deps.config.gid);
      await file.chmod(SHARED_FILE_MODE);
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  }

  /**
   * The configuration the agent host starts from: the template, keeping the
   * session identity an earlier run saved, as `ensureSharedProcess` does.
   */
  private async writeConfig(watcher: string, template: SharedHostConfig): Promise<void> {
    const path = join(watcher, 'config.json');
    const text = await readOptional(path);
    let config: SharedHostConfig = template;
    if (text !== null) {
      const saved = sharedConfigSchema.parse(JSON.parse(text));
      if (
        saved.session.agentId !== template.session.agentId ||
        saved.start.provider !== template.start.provider ||
        saved.start.input.cwd !== template.start.input.cwd
      )
        throw new Error(
          'The saved agent host identity or working directory differs from the one asked for.'
        );
      config = { ...template, session: saved.session, resumeOperationId: saved.resumeOperationId };
    }
    await this.writeShared(path, JSON.stringify(config));
  }

  private writeFlags(watcher: string, flags: WatchFlags): Promise<void> {
    return this.writeShared(
      join(watcher, WATCH_FLAGS_FILE),
      JSON.stringify(watchFlagsSchema.parse(flags))
    );
  }

  /**
   * The provider settings from the controller's environment an agent is
   * given, but those naming a path in the controller user's home.
   */
  private agentEnvironment(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of AGENT_ENV_VARS) {
      const value = this.deps.env[name];
      if (value === undefined || PATH_VARIABLES.has(name)) continue;
      env[name] = value;
    }
    return env;
  }

  /** The environment file the unit loads, in the syntax systemd reads. */
  private async writeEnvironment(slot: number): Promise<void> {
    const lines: string[] = [];
    for (const [name, value] of Object.entries(this.agentEnvironment())) {
      if (/[\n\r]/.test(value))
        throw new ReasonedError(
          'definition_invalid',
          `The controller's ${name} holds a line break, which an agent's environment cannot carry.`
        );
      lines.push(environmentLine(name, value));
    }
    const directory = unitFilesDir(this.deps.config, slot);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeAtomic(join(directory, 'environment'), lines.length ? `${lines.join('\n')}\n` : '');
  }

  private async show(unit: string): Promise<UnitState> {
    const stdout = await this.deps.systemctl([
      'show',
      unit,
      '--property=ActiveState,Result,MainPID',
    ]);
    const values = new Map<string, string>();
    for (const line of stdout.split('\n')) {
      const at = line.indexOf('=');
      if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim());
    }
    const activeState = values.get('ActiveState');
    if (!activeState) throw new Error(`systemctl show did not report the state of ${unit}.`);
    return {
      activeState,
      result: values.get('Result') ?? '',
      mainPid: Number(values.get('MainPID') ?? 0) || 0,
    };
  }
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

/**
 * `NAME='value'` as systemd's `EnvironmentFile=` reads it: single quotes keep
 * everything literal; a value holding one is double-quoted instead, with the
 * characters systemd unescapes there escaped.
 */
export function environmentLine(name: string, value: string): string {
  if (!value.includes("'")) return `${name}='${value}'`;
  return `${name}="${value.replace(/(["\\$`])/g, '\\$1')}"`;
}
