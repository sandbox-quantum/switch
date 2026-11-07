/**
 * Everything decided before Switch starts a Pi (READY §2.1, §2.3, §2.4;
 * `ready_errata.md` ER-01, ER-03, ER-05, ER-09, ER-10): which executable, its
 * version, the profile, the project's pending migrations, the session's MCP
 * server names, the environment, the arguments, and the bridge's files. The
 * same `preparePiLaunch` serves a session, a discovery of models and the
 * sign-in check, so all three run the same Pi with the same profile check, the
 * same environment and arguments from the same `piArgs`. Starting Pi and
 * driving it is the adapter's (stage 5).
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, existsSync, type Stats } from 'node:fs';
import { access, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import type { McpServerSpec } from '../adapter';
import {
  bridgeSource,
  PI_BRIDGE_CONFIG_ENV,
  PI_BRIDGE_PROTOCOL_VERSION,
  type PiBridgeConfig,
} from './bridge';
import { piArgs, type PiSessionTarget } from './pi-args';
import { PI_BASH_MARKER_ENV } from './pi-bash';
import { PI_AGENT_DIR_ENV, piAgentDir } from './pi-paths';
import { checkPiProfile, preparePiProfile } from './pi-profile';
import { assertPiVersion, PiVersionError } from './pi-version';

/** Why Switch will not start Pi, other than its version (`PiVersionError`) or its profile (`PiProfileError`). */
export class PiLaunchError extends Error {
  constructor(
    readonly reason: 'binary' | 'migration' | 'mcp' | 'model' | 'shell',
    message: string
  ) {
    super(message);
    this.name = 'PiLaunchError';
  }
}

/** Where Switch keeps its Pi state: the profile's parent (bridge, sessions, per-session runs). */
export function piStateDir(env: Record<string, string | undefined>): string {
  return dirname(piAgentDir(env));
}

/**
 * The environment of every Pi Switch starts, from the environment the session
 * was given (already merged by the host, `sdk-env.ts`): no `PI_*` variable but
 * `PI_CODING_AGENT_DIR`, which is always Switch's profile. Pi (`PI_VERSION`) reads these
 * `PI_*` itself (`dist/config.js:317`, `:476-477`, `:484`; `main.js:455`;
 * `core/telemetry.js:6`, …): one would move its package, its sessions or its
 * share links, or change its network use, and none is Switch's to inherit.
 * Neither are the bridge's config (`SWITCH_PI_BRIDGE`) and the shells' marker
 * (`SWITCH_PI_TC`): the bridge's config is the session's own (`bridgeConfig`).
 */
export function piEnv(
  env: Record<string, string>,
  options: { bridgeConfig?: string } = {}
): Record<string, string> {
  const own = Object.fromEntries(
    Object.entries(env).filter(
      ([name]) =>
        !name.startsWith('PI_') && name !== PI_BRIDGE_CONFIG_ENV && name !== PI_BASH_MARKER_ENV
    )
  );
  own[PI_AGENT_DIR_ENV] = piAgentDir(env);
  if (options.bridgeConfig) own[PI_BRIDGE_CONFIG_ENV] = options.bridgeConfig;
  return own;
}

async function runnable(file: string): Promise<boolean> {
  try {
    const found = await stat(file);
    if (!found.isFile()) return false;
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The one executable a Pi is started from, resolved once (P-08) to an absolute
 * path that the version check, the sign-in check and Pi itself all run:
 * `binaryPath` when it is an absolute path (the version check then says when
 * it cannot run), else the first file of that name (`pi` when undefined) on
 * the environment's PATH that Switch may run. One earlier on PATH that cannot
 * run is passed over, as the shell does, so the version checked is the
 * version that runs. None at all is a `PiVersionError`, which says what to
 * install.
 *
 * A relative path (`./pi`, `bin/pi`) is refused (`PiLaunchError` `binary`):
 * each start would find it from its own directory — the version check from
 * one of no project (`pi-version.ts`), the sign-in check and Pi from the
 * project — so it could name a different program each time. The other
 * providers pass their `binaryPath` to every start unchanged
 * (`codex/codex-adapter.ts:402`, `:441`; `claude/sign-in.ts:43`;
 * `acp/acp-adapter.ts:167`) and check no version against it; Pi's version is
 * bound to the program (ER-09), so its path must not depend on a directory,
 * as no path in Pi's arguments does (`pi-args.ts` `path`).
 */
export async function resolvePiBinary(
  binaryPath: string | undefined,
  env: Record<string, string>
): Promise<string> {
  if (binaryPath?.includes('/')) {
    if (!isAbsolute(binaryPath))
      throw new PiLaunchError(
        'binary',
        `Switch starts Pi only from an absolute path or a name it finds on PATH, not ${JSON.stringify(binaryPath)}: a relative path would name a different program from each directory Pi is started in. Set the agent's Pi to an absolute path, or to "pi".`
      );
    return binaryPath;
  }
  const name = binaryPath || 'pi';
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    const file = join(dir, name);
    if (await runnable(file)) return file;
  }
  throw new PiVersionError(null, { reason: 'ENOENT' });
}

/**
 * Throws when Pi would migrate the project at `cwd` on start (ER-10): a
 * `.pi/commands` with no `.pi/prompts` beside it, which Pi renames, trusted or
 * not (`dist/migrations.js:124-131`, `:232-237`). Whether each is there is
 * decided as Pi decides it, with `existsSync` (`migrations.js:127`), which
 * follows a link: a link to nothing is not there, for Switch as for Pi. A
 * `.pi/settings.json.lock` Pi may leave in a project is a known limit.
 */
export async function assertPiMigrations(cwd: string): Promise<void> {
  const project = join(cwd, '.pi');
  if (existsSync(join(project, 'commands')) && !existsSync(join(project, 'prompts')))
    throw new PiLaunchError(
      'migration',
      `Pi would rename ${join(project, 'commands')} to ${join(project, 'prompts')} in this project when it starts. Switch does not change a project's Pi files: rename it yourself (or run pi there once), then start the agent again.`
    );
}

/** Pi's grammar for a server name (`dist/core/mcp-servers.js:48`). */
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;

/**
 * Throws unless every session MCP server name leaves each tool's owner plain
 * (ER-05): Pi names tools `mcp__<name with - as _>__<tool>`
 * (`dist/core/mcp-servers.js:50-52`), so no name may hold `__` once `-` is `_`,
 * no two may share that form, and none may be another's followed by `_`. The
 * bridge refuses the same config (`bridge.ts`); this says why before Pi starts.
 */
export function assertPiMcpNames(names: readonly string[]): void {
  const forms = names.map((name) => name.replace(/-/g, '_'));
  for (const [index, name] of names.entries()) {
    const own = forms[index] as string;
    const twin = names.find((other, at) => at !== index && forms[at] === own);
    const shorter = names.find((other, at) => at !== index && own.startsWith(`${forms[at]}_`));
    const problem = !SERVER_NAME.test(name)
      ? 'Pi takes only letters, digits, "_" and "-" in a server name'
      : own.includes('__')
        ? 'Pi would not tell its tools from another server’s: it holds "__" (with "-" read as "_")'
        : twin !== undefined
          ? `Pi names its tools as it names those of "${twin}"`
          : shorter !== undefined
            ? `Pi would not tell its tools from those of "${shorter}"`
            : undefined;
    if (problem)
      throw new PiLaunchError(
        'mcp',
        `Switch will not start Pi with the MCP server "${name}": ${problem}. Rename one of the servers.`
      );
  }
}

/**
 * The shell the bridge's `bash` runs, when one is configured (Q7 D,
 * `09_human_decisions_r1.md:63`): only a path every part of which only its
 * owner or root may change — an absolute path to an executable file, owned by
 * root or by this user and writable by no one else, in directories that are
 * the same. Never Pi's `shellPath` or `shellCommandPrefix` setting
 * (`pi-profile.ts`).
 */
export async function piTrustedShellPath(shellPath: string): Promise<string> {
  const refuse = (why: string) =>
    new PiLaunchError('shell', `Switch will not run commands with the shell ${shellPath}: ${why}.`);
  if (!isAbsolute(shellPath)) throw refuse('it is not an absolute path');
  const real = await realpath(shellPath).catch(() => {
    throw refuse('it does not exist');
  });
  const uid = process.getuid?.() ?? -1;
  const trusted = (found: Stats) => (found.uid === 0 || found.uid === uid) && !(found.mode & 0o022);
  const file = await stat(real);
  if (!file.isFile() || !trusted(file))
    throw refuse('someone other than its owner or root may change it');
  if (!(await runnable(real))) throw refuse('it is not a file Switch can run');
  for (let dir = dirname(real); ; dir = dirname(dir)) {
    const found = await stat(dir);
    // A sticky directory (/tmp) lets no one but a file's owner replace it.
    if (!trusted(found) && !(found.mode & 0o1000 && found.uid === 0))
      throw refuse(`someone other than its owner or root may change ${dir}`);
    if (dir === dirname(dir)) break;
  }
  return real;
}

/** A file written whole or not at all, 0600, in a directory created 0700. */
async function writeAtomic(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** The bridge module Pi loads with `-e`, written once per content (READY §2.3). */
async function writeBridge(stateDir: string): Promise<string> {
  const source = bridgeSource();
  const hash = createHash('sha256').update(source).digest('hex').slice(0, 8);
  const file = join(stateDir, `bridge-${hash}.mjs`);
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current !== source) await writeAtomic(file, source);
  return file;
}

export interface PiLaunchInput {
  /** A session, a discovery of models, or the sign-in check. */
  kind: 'session' | 'discovery' | 'readiness';
  /** The Pi executable; the first `pi` on the environment's PATH when undefined. */
  binaryPath?: string | undefined;
  /** The session's complete environment (`ProviderSessionStartInput.env`). */
  env: Record<string, string>;
  /** The session's directory: its project. */
  cwd: string;
  /** A session's model (`--model`): a session has one (Q4). */
  model?: string;
  /** A new session's id (a random one when absent), or the transcript to resume (ER-07). */
  session?: PiSessionTarget;
  /** A session's MCP servers, by name (`ProviderSessionStartInput.mcpServers`). */
  mcpServers?: Record<string, McpServerSpec>;
  /** A shell for the bridge's `bash` (`piTrustedShellPath`); Pi's default when absent. */
  shellPath?: string;
  /** The version check's time; its own default when absent. */
  versionTimeoutMs?: number;
  /**
   * A session's owner, written as its directory's `owner.json` (`JSON.stringify`, 0600) as
   * that directory comes to be, so that no launch directory is ever without one (R3-E): when
   * given, the directory is made beside its place under the name of one being made
   * (`PI_RUN_PREPARING_PREFIX`), its owner written first, then its config, and renamed into
   * place. Without it, as before.
   */
  owner?: Readonly<Record<string, unknown>>;
}

/**
 * What a launch directory is named under `<state>/run` while it is made (R3-E): a name of its
 * own (O-9 A′, S4-11), never the one the adapter gives a directory it removes (`pi-adapter.ts`
 * `REMOVED_PREFIX`, `.removed-`). No Pi ran in it (Pi is started on the name it is renamed to).
 * The adapter's sweep removes one only once its `owner.json`, written first, is whole and names
 * a host that is gone; the recovery (`pi-conversation.ts` `launchesLeft`) knows the name too.
 */
export const PI_RUN_PREPARING_PREFIX = '.preparing-';

export interface PiLaunch {
  /** The executable every step used: version check, sign-in check and Pi alike. */
  command: string;
  /** `piArgs` for a session or a discovery; empty for the sign-in check, whose arguments are per provider. */
  args: string[];
  env: Record<string, string>;
  cwd: string;
  agentDir: string;
  /** A session's own directory (its bridge config and process registry), for `stopSession` to remove. */
  runDir?: string;
  /** What a session's bridge was configured with; `mcpServers` names the servers `pi-policy.ts` knows. */
  bridgeConfig?: PiBridgeConfig;
}

/**
 * Prepares a Pi start. In order, each a refusal when it fails: the executable
 * (`resolvePiBinary`), the profile (`checkPiProfile`, read only), the version
 * (`assertPiVersion`, exactly `PI_VERSION`, asked with `piEnv`), and for a
 * session or a discovery the project's migrations (`assertPiMigrations`); for
 * a session, a model and the MCP server names (`assertPiMcpNames`). Only then
 * is anything written: for a session or a discovery the profile is set up
 * (`preparePiProfile`, which checks it again under its lock) and the bridge
 * module written; for a session, its own directory with the bridge's config
 * (0600) and a nonce, and its `owner.json` when `owner` is given, both there
 * from the moment the directory is (R3-E). The sign-in check writes nothing.
 */
export async function preparePiLaunch(input: PiLaunchInput): Promise<PiLaunch> {
  const command = await resolvePiBinary(input.binaryPath, input.env);
  const agentDir = piAgentDir(input.env);
  await checkPiProfile(agentDir);
  const env = piEnv(input.env);
  await assertPiVersion(command, {
    env,
    ...(input.versionTimeoutMs === undefined ? {} : { timeoutMs: input.versionTimeoutMs }),
  });
  if (input.kind === 'readiness') return { command, args: [], env, cwd: input.cwd, agentDir };

  await assertPiMigrations(input.cwd);
  const mcpServers = input.kind === 'session' ? (input.mcpServers ?? {}) : {};
  let model = '';
  let shellPath: string | undefined;
  if (input.kind === 'session') {
    model = input.model ?? '';
    if (!model)
      throw new PiLaunchError('model', 'A Pi session needs a model: choose one for the agent.');
    assertPiMcpNames(Object.keys(mcpServers));
    if (input.shellPath !== undefined) shellPath = await piTrustedShellPath(input.shellPath);
  }

  await preparePiProfile(agentDir);
  const stateDir = piStateDir(input.env);
  const bridgePath = await writeBridge(stateDir);
  if (input.kind === 'discovery')
    return {
      command,
      args: piArgs({ kind: 'discovery', bridgePath }),
      env,
      cwd: input.cwd,
      agentDir,
    };

  const sessionDir = join(stateDir, 'sessions');
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  const runRoot = join(stateDir, 'run');
  const runDir = join(runRoot, randomBytes(12).toString('hex'));
  const bridgeConfig: PiBridgeConfig = {
    protocolVersion: PI_BRIDGE_PROTOCOL_VERSION,
    nonce: randomBytes(24).toString('base64url'),
    mcpServers,
    processRegistry: join(runDir, 'processes.jsonl'),
    ...(shellPath === undefined ? {} : { shellPath }),
  };
  const configFile = join(runDir, 'config.json');
  if (input.owner === undefined) {
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    await writeFile(configFile, JSON.stringify(bridgeConfig), { mode: 0o600, flag: 'wx' });
  } else {
    // R3-E: whole, its owner in it, or under the name of one being made. O-9 A′: its owner
    // first, so that a sweep can tell whose it is as soon as it can tell anything.
    await mkdir(runRoot, { recursive: true, mode: 0o700 });
    const making = join(runRoot, `${PI_RUN_PREPARING_PREFIX}${randomUUID()}`);
    try {
      await mkdir(making, { mode: 0o700 });
      await writeFile(join(making, 'owner.json'), JSON.stringify(input.owner), {
        mode: 0o600,
        flag: 'wx',
      });
      await writeFile(join(making, 'config.json'), JSON.stringify(bridgeConfig), {
        mode: 0o600,
        flag: 'wx',
      });
      await rename(making, runDir);
    } catch (error) {
      await rm(making, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
  return {
    command,
    args: piArgs({
      kind: 'session',
      bridgePath,
      sessionDir,
      session: input.session ?? { id: randomUUID() },
      model,
    }),
    env: piEnv(input.env, { bridgeConfig: configFile }),
    cwd: input.cwd,
    agentDir,
    runDir,
    bridgeConfig,
  };
}
