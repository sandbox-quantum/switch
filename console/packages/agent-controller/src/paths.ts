import { chmod, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { ConfigurationError } from './errors';

export const DATA_DIR_ENV = 'SWITCH_CONTROLLER_DATA_DIR';

/**
 * Where the controller keeps its state when nothing names a directory:
 * macOS `~/Library/Application Support/Switch/agent-controller`, Linux
 * `$XDG_STATE_HOME/switch/agent-controller` or
 * `~/.local/state/switch/agent-controller`.
 */
export function defaultDataDir(input: {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}): string {
  if (input.platform === 'darwin')
    return join(input.home, 'Library', 'Application Support', 'Switch', 'agent-controller');
  if (input.platform === 'win32') {
    const local = input.env.LOCALAPPDATA;
    if (!local)
      throw new ConfigurationError(
        `LOCALAPPDATA is not set; pass --data-dir or set ${DATA_DIR_ENV}.`
      );
    return join(local, 'Switch', 'agent-controller');
  }
  const xdg = input.env.XDG_STATE_HOME;
  // The XDG spec ignores a relative value, so does this.
  const state = xdg && isAbsolute(xdg) ? xdg : join(input.home, '.local', 'state');
  return join(state, 'switch', 'agent-controller');
}

/** `--data-dir`, then `SWITCH_CONTROLLER_DATA_DIR`, then the OS default. */
export function resolveDataDir(flag: string | undefined): string {
  const named = flag ?? process.env[DATA_DIR_ENV];
  if (named) return resolve(named);
  return defaultDataDir({ platform: process.platform, env: process.env, home: homedir() });
}

/**
 * Creates the data directory owner-only (0700), and tightens one that already
 * exists with looser permissions: it holds the controller credential and every
 * agent's relay token.
 */
export async function ensureDataDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') return;
  const mode = (await stat(dir)).mode & 0o777;
  if (mode !== 0o700) await chmod(dir, 0o700);
}

export type DataLayout = {
  root: string;
  database: string;
  secrets: string;
  agentDir: (agentId: string) => string;
  agentCredentials: (agentId: string) => string;
  watcherRoot: (agentId: string) => string;
};

/**
 * Where agents with no directory of their own work, for one server: a short
 * folder in the home directory named after the server's address, shared by
 * every controller on the machine that talks to it, rather than a path inside
 * a controller's data directory.
 */
export function serverWorkspacesDir(server: string): string {
  const { host } = new URL(server);
  const segment = host.replace(/[^A-Za-z0-9._-]+/g, '-');
  if (!isSafeSegment(segment))
    throw new ConfigurationError(`The server address '${server}' cannot name a folder.`);
  return join(homedir(), '.switch', 'agents', segment);
}

/** An agent's working directory under `workspaces`, when its definition names none. */
export function agentWorkspace(workspaces: string, name: string): string {
  return join(workspaces, safeSegment(name, 'agent name'));
}

export function dataLayout(root: string): DataLayout {
  return {
    root,
    database: join(root, 'controller.db'),
    secrets: join(root, 'secrets'),
    agentDir: (agentId) => join(root, 'agents', safeSegment(agentId, 'agent id')),
    agentCredentials: (agentId) =>
      join(root, 'agents', safeSegment(agentId, 'agent id'), 'credentials.json'),
    watcherRoot: (agentId) => join(root, 'watchers', safeSegment(agentId, 'agent id')),
  };
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/** A server-supplied value about to become one path segment under the data directory. */
export function isSafeSegment(value: string): boolean {
  return SAFE_SEGMENT.test(value) && !value.includes('..');
}

function safeSegment(value: string, what: string): string {
  if (!isSafeSegment(value))
    throw new Error(`The ${what} '${value}' cannot be used as a directory name.`);
  return value;
}

/** The agent ids a systemd template unit instance may carry. */
export const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function requireAgentId(agentId: string): string {
  if (!AGENT_ID.test(agentId))
    throw new Error(`The agent id '${agentId}' is not a valid unit instance.`);
  return agentId;
}

export type Ec2Layout = {
  dataRoot: string;
  agentsRoot: string;
  worktreesRoot: string;
  runDir: string;
  agentRoot: (agentId: string) => string;
  watcherRoot: (agentId: string) => string;
  worktreeRoot: (agentId: string) => string;
  credentialsFile: (agentId: string) => string;
  providerFile: (agentId: string) => string;
  envFile: (agentId: string) => string;
  unitCredentialsPath: (agentId: string) => string;
  unit: (agentId: string) => string;
};

/**
 * A cloud machine's layout: agent roots and worktrees on the data volume, and
 * the files each agent unit loads at start in the controller's runtime
 * directory.
 */
export function ec2Layout(input: { dataRoot: string; runRoot: string }): Ec2Layout {
  const agentsRoot = join(input.dataRoot, 'agents');
  const worktreesRoot = join(input.dataRoot, 'worktrees');
  const runDir = join(input.runRoot, 'agents');
  const unit = (agentId: string) => `switch-agent@${requireAgentId(agentId)}.service`;
  return {
    dataRoot: input.dataRoot,
    agentsRoot,
    worktreesRoot,
    runDir,
    agentRoot: (agentId) => join(agentsRoot, requireAgentId(agentId)),
    watcherRoot: (agentId) => join(agentsRoot, requireAgentId(agentId), 'watcher'),
    worktreeRoot: (agentId) => join(worktreesRoot, requireAgentId(agentId)),
    credentialsFile: (agentId) => join(runDir, `${requireAgentId(agentId)}.credentials.json`),
    providerFile: (agentId) => join(runDir, `${requireAgentId(agentId)}.provider.json`),
    envFile: (agentId) => join(runDir, `${requireAgentId(agentId)}.env`),
    unitCredentialsPath: (agentId) => join('/run/credentials', unit(agentId), 'agent'),
    unit,
  };
}
