import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import type {
  RemoteStackProbe,
  ServerLockHolder,
  SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  CORE_SERVICE,
  ENV_FILE_NAME,
  ENV_STAMP_FILE_NAME,
  STACK_HELPER_IMAGE,
  STACK_STATE_LABEL,
  STACK_STATE_VOLUME_SUFFIX,
} from './constants';
import { classifyVersionDrift, imageTag } from './deployed-version';
import { readStackEnv, type StackEnv } from './env-file';
import { commandFailure, errorText } from './error-text';
import type { ServerHost } from './host/types';
import type { ServerLease } from './stack-lock';
import { WHILE_HOLDING_SERVER_LOCK } from './state-mutex';

/**
 * What a remote host has of a Switch Console-managed stack, read off the host
 * rather than this desktop's store (CHOO-2893). Every account sharing the host
 * needs the credentials the stack's volumes were created with; a Console that
 * generated its own would lock the stack out of its database. So the `.env`
 * the stack last started with is published to a Docker volume every account
 * reaches through the daemon, and compose run from any working dir with that
 * byte-identical `.env` leaves the containers alone.
 */

/** Only the remote host shares its stack, so only it provides this. */
export type StackStateHost = Pick<
  ServerHost,
  'ctx' | 'dockerBin' | 'composeProjectName' | 'label' | 'workingDir' | 'readFile'
> & {
  writeCommandInput(
    command: string,
    args: string[],
    input: string,
    opts: { timeoutMs: number }
  ): Promise<void>;
};

const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';
const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';
const COMPOSE_WORKING_DIR_LABEL = 'com.docker.compose.project.working_dir';

const STATE_MOUNT = '/state';
const PUBLISHED_ENV_FILE = 'stack.env';
/** Beside the published copy: which database volume it was written for. */
const PUBLISHED_STAMP_FILE = 'stack.db';
/** Separates the copy from its stamp when both come back from one read. */
const STAMP_MARKER = '---switch-console-stamp---';

/** Holds the Postgres data whose credentials the published copy must match. */
const DATABASE_VOLUME = 'pgdata';

const QUICK_TIMEOUT_MS = 60_000;
/** A host that has never run the stack has to pull the helper image first. */
const PULL_TIMEOUT_MS = 10 * 60_000;

export function stackStateVolume(host: Pick<StackStateHost, 'composeProjectName'>): string {
  return `${host.composeProjectName}_${STACK_STATE_VOLUME_SUFFIX}`;
}

/** Nothing passed here may be a secret: the arguments are visible in the
 * host's process table. */
async function docker(
  host: StackStateHost,
  args: string[],
  timeout: number = QUICK_TIMEOUT_MS
): Promise<string> {
  try {
    const { stdout } = await host.ctx.exec(host.dockerBin, args, {
      timeout,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    throw new Error(`docker ${args[0]} on ${host.label} failed: ${commandFailure(error)}`);
  }
}

function lines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

export type ProjectContainer = {
  service: string;
  /** Docker's own word: `running`, `exited`, `created`, … */
  state: string;
  /** The working dir of the account whose compose created this container. */
  workingDir: string | null;
  image: string;
};

export type ProjectResources = {
  /** Every container of the stack's compose project, stopped ones included. */
  containers: ProjectContainer[];
  /** The stack's own named volumes — Postgres and Mattermost data. */
  dataVolumes: string[];
  stateVolume: boolean;
};

/** Found by label rather than through a compose file, so it sees a stack
 * another account started from a working dir this one cannot read. */
export async function listProjectResources(host: StackStateHost): Promise<ProjectResources> {
  const [containers, dataVolumes, stateVolume] = await Promise.all([
    listContainers(host),
    listDataVolumes(host),
    stateVolumeExists(host),
  ]);
  return { containers, dataVolumes, stateVolume };
}

async function listContainers(host: StackStateHost): Promise<ProjectContainer[]> {
  return lines(
    await docker(host, [
      'ps',
      '--all',
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}=${host.composeProjectName}`,
      '--format',
      `{{.Label "${COMPOSE_SERVICE_LABEL}"}}\t{{.State}}\t{{.Label "${COMPOSE_WORKING_DIR_LABEL}"}}\t{{.Image}}`,
    ])
  ).map((line) => {
    const [service = '', state = '', workingDir = '', image = ''] = line.split('\t');
    return { service, state, workingDir: workingDir || null, image };
  });
}

export async function stateVolumeExists(host: StackStateHost): Promise<boolean> {
  const stateVolumes = lines(
    await docker(host, [
      'volume',
      'ls',
      '--filter',
      `label=${STACK_STATE_LABEL}=${host.composeProjectName}`,
      '--format',
      '{{.Name}}',
    ])
  );
  return stateVolumes.includes(stackStateVolume(host));
}

async function listDataVolumes(host: StackStateHost): Promise<string[]> {
  return lines(
    await docker(host, [
      'volume',
      'ls',
      '--filter',
      `label=${COMPOSE_PROJECT_LABEL}=${host.composeProjectName}`,
      '--format',
      '{{.Name}}',
    ])
  );
}

/** The database volume's creation time. It changes exactly when a reset
 * recreates the volume, so it tells a copy written for this database from a
 * leftover. */
async function databaseStamp(host: StackStateHost, dataVolumes: string[]): Promise<string | null> {
  const volume = `${host.composeProjectName}_${DATABASE_VOLUME}`;
  if (!dataVolumes.includes(volume)) return null;
  const stamp = await docker(host, ['volume', 'inspect', '--format', '{{.CreatedAt}}', volume]);
  return stamp.trim() || null;
}

/** What the launcher says on stderr when the host has no helper image, so the
 * caller can pull it under a pull's timeout and try again. */
const HELPER_IMAGE_MISSING = 'switch-console: the helper image is not on this host';

/**
 * Runs a container against the state volume in one round trip. Without the
 * helper image it falls back to the image the stack's Postgres container runs
 * (same shell and `flock`); only when neither exists does it fail, so the
 * caller pulls under a pull's timeout rather than inside a quick one.
 *
 * `$1…$8`: docker binary, helper image, volume, its label, `yes` to create it,
 * compose project, mount, `yes` for stdin; then the script and its arguments.
 */
const LAUNCHER = [
  'docker=$1 image=$2 volume=$3 label=$4 create=$5 project=$6 mount=$7 stdin=$8',
  'shift 8',
  'if ! "$docker" image inspect "$image" >/dev/null 2>&1; then',
  `  own=$("$docker" ps -a --filter "label=com.docker.compose.project=$project" --filter label=com.docker.compose.service=postgres --format '{{.Image}}' | head -n 1)`,
  '  if [ -n "$own" ] && "$docker" image inspect "$own" >/dev/null 2>&1; then image=$own',
  `  else echo '${HELPER_IMAGE_MISSING}' >&2; exit 97; fi`,
  'fi',
  'if [ "$create" = yes ]; then "$docker" volume create --label "$label" "$volume" >/dev/null || exit 1; fi',
  'interactive=',
  'if [ "$stdin" = yes ]; then interactive=--interactive; fi',
  'script=$1',
  'shift',
  'exec "$docker" run --rm $interactive --network none --volume "$mount" --entrypoint sh "$image" -c "$script" stack-state "$@"',
].join('\n');

type StateContainer = {
  /** A read never creates the volume; the caller has checked it exists. */
  mode: 'read' | 'write';
  script: string;
  /** Arrive as `$1…`. Visible in the host's process table: never a secret. */
  scriptArgs: string[];
};

function launcherArgs(host: StackStateHost, container: StateContainer, interactive: boolean) {
  const mount = `${stackStateVolume(host)}:${STATE_MOUNT}${container.mode === 'read' ? ':ro' : ''}`;
  return [
    '-c',
    LAUNCHER,
    'state-launcher',
    host.dockerBin,
    STACK_HELPER_IMAGE,
    stackStateVolume(host),
    `${STACK_STATE_LABEL}=${host.composeProjectName}`,
    container.mode === 'write' ? 'yes' : 'no',
    host.composeProjectName,
    mount,
    interactive ? 'yes' : 'no',
    container.script,
    ...container.scriptArgs,
  ];
}

/** Run `launch` once, and again after pulling the helper image when the host
 * turns out not to have it. */
async function withHelperImage<T>(host: StackStateHost, launch: () => Promise<T>): Promise<T> {
  try {
    return await launch();
  } catch (error) {
    if (!errorText(error).includes(HELPER_IMAGE_MISSING)) throw error;
    await docker(host, ['pull', '--quiet', STACK_HELPER_IMAGE], PULL_TIMEOUT_MS);
    return launch();
  }
}

async function runStateContainer(host: StackStateHost, container: StateContainer): Promise<string> {
  return withHelperImage(host, async () => {
    try {
      const { stdout } = await host.ctx.exec('sh', launcherArgs(host, container, false), {
        timeout: QUICK_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      throw new Error(`docker run on ${host.label} failed: ${commandFailure(error)}`);
    }
  });
}

/** Mounts the state volume read-only. The volume must already exist: `docker
 * run -v` would otherwise create it, and a read must not. */
export async function readStateVolume(host: StackStateHost, script: string): Promise<string> {
  return runStateContainer(host, { mode: 'read', script, scriptArgs: [] });
}

/** `input` goes on stdin, the only way a secret may reach the script. Creates
 * the volume on first use. */
export async function writeStateVolume(
  host: StackStateHost,
  script: string,
  input: string,
  scriptArgs: string[]
): Promise<void> {
  await withHelperImage(host, () =>
    host.writeCommandInput(
      'sh',
      launcherArgs(host, { mode: 'write', script, scriptArgs }, true),
      input,
      { timeoutMs: QUICK_TIMEOUT_MS }
    )
  );
}

/** Read-write, returning stdout. `scriptArgs` are visible in the host's
 * process table; a secret goes through {@link writeStateVolume}'s stdin.
 * Creates the volume on first use. */
export async function runStateScript(
  host: StackStateHost,
  script: string,
  scriptArgs: string[]
): Promise<string> {
  return runStateContainer(host, { mode: 'write', script, scriptArgs });
}

/** The published `.env`, and the database volume it was written for (null
 * when that was not recorded). */
export type PublishedCopy = { env: string; stamp: string | null };

export async function readPublishedCopy(host: StackStateHost): Promise<PublishedCopy | null> {
  const out = await readStateVolume(
    host,
    `cat "${STATE_MOUNT}/${PUBLISHED_ENV_FILE}" 2>/dev/null; printf '\\n%s\\n' '${STAMP_MARKER}'; ` +
      `cat "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}" 2>/dev/null; true`
  );
  // The marker follows a newline of its own; taking exactly that one back off
  // leaves the copy byte for byte as published.
  const split = out.lastIndexOf(`\n${STAMP_MARKER}`);
  const env = split === -1 ? out : out.slice(0, split);
  const stamp = split === -1 ? '' : out.slice(split + 1 + STAMP_MARKER.length).trim();
  if (env.trim().length === 0) return null;
  return { env, stamp: stamp || null };
}

/** Reads the stamp from stdin's first line and the copy from the rest; the
 * server lock's token is `$1`. */
const PUBLISH_SCRIPT = [
  'set -e',
  WHILE_HOLDING_SERVER_LOCK,
  'umask 077',
  'IFS= read -r stamp',
  `cat > "${STATE_MOUNT}/.${PUBLISHED_ENV_FILE}.tmp"`,
  `mv "${STATE_MOUNT}/.${PUBLISHED_ENV_FILE}.tmp" "${STATE_MOUNT}/${PUBLISHED_ENV_FILE}"`,
  'if [ -n "$stamp" ]; then',
  `  printf "%s\\n" "$stamp" > "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp"`,
  `  mv "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp" "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
  'else',
  `  rm -f "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
  'fi',
].join('\n');

/**
 * Atomically publish `env`, the exact file a start gives compose, only while
 * `lease` still holds the server lock (checked in the same step), so a Console
 * that lost the lock cannot publish its credentials over its successor's. The
 * copy is written before its stamp, so a read in between sees a mismatch,
 * never a false match. Returns null when there is no database volume yet; the
 * start then calls {@link stampPublishedEnv} once compose has created it.
 */
export async function publishEnv(
  host: StackStateHost,
  env: string,
  lease: ServerLease
): Promise<string | null> {
  const stamp = await databaseStamp(host, await listDataVolumes(host));
  await writeStateVolume(host, PUBLISH_SCRIPT, `${stamp ?? ''}\n${env}`, [lease.token]);
  return stamp;
}

/** Unstamped, a first start's copy would still look current after a reset
 * from a Console that does not publish. */
export async function stampPublishedEnv(
  host: StackStateHost,
  lease: ServerLease
): Promise<string | null> {
  const stamp = await databaseStamp(host, await listDataVolumes(host));
  if (stamp === null) {
    log.warn(
      `stack-state: the stack on ${host.label} has no database volume after starting, ` +
        `so its published settings are not stamped with one`
    );
    return null;
  }
  await writeStateVolume(
    host,
    `set -e\n${WHILE_HOLDING_SERVER_LOCK}\n` +
      `umask 077 && IFS= read -r stamp && ` +
      `printf "%s\\n" "$stamp" > "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp" && ` +
      `mv "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp" "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
    `${stamp}\n`,
    [lease.token]
  );
  return stamp;
}

/** For a reset: the copy's credentials die with the data volumes, and the next
 * Console would otherwise adopt credentials that open nothing. The rest of the
 * volume, including the activity record, is kept. */
export async function withdrawPublishedEnv(
  host: StackStateHost,
  lease: ServerLease
): Promise<void> {
  if (!(await stateVolumeExists(host))) return;
  await writeStateVolume(
    host,
    `set -e\n${WHILE_HOLDING_SERVER_LOCK}\n` +
      `rm -f "${STATE_MOUNT}/${PUBLISHED_ENV_FILE}" "${STATE_MOUNT}/.${PUBLISHED_ENV_FILE}.tmp" ` +
      `"${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
    '',
    [lease.token]
  );
}

export type StackEnvSource = 'published' | 'working-dir';

export type StackOnHost =
  /** No containers or data: the only case where new credentials may be made. */
  | { kind: 'absent' }
  /** `published` is false for a stack started before publishing existed,
   * which the next start or connect publishes. */
  | {
      kind: 'present';
      env: StackEnv;
      /** The exact `.env` text, so what gets published is what compose read. */
      raw: string;
      source: StackEnvSource;
      running: boolean;
      published: boolean;
      /** What the running core container is on, where `env.version` is what it
       * was last asked to be; they differ when a start published then failed. */
      runningVersion: string | null;
      /** The database volume these settings were written for, if recorded. */
      stamp: string | null;
    }
  /** Another account's never-published stack, whose settings this account
   * cannot read. Starting here would recreate it with new credentials. */
  | { kind: 'unshared'; ownerDir: string | null; running: boolean }
  /** `raw` lets a start check another copy of the settings against what this
   * one does carry before filling the gaps from it. */
  | {
      kind: 'incomplete';
      source: StackEnvSource;
      missing: string[];
      raw: string;
      running: boolean;
    }
  /** Distinct from `absent`: an unreachable daemon is not an empty host. */
  | { kind: 'unreadable'; reason: string };

export function unsharedStackMessage(hostLabel: string, ownerDir: string | null): string {
  const where = ownerDir ? ` (from ${ownerDir})` : '';
  return (
    `The Switch server on ${hostLabel} was set up from another account${where} and its settings ` +
    `have not been shared, so this account cannot read them. Starting it from here would ` +
    `replace its credentials and take it down, so nothing was changed. It is shared the next ` +
    `time an up-to-date Switch Console starts or connects to it from the account that set it up.`
  );
}

/** Compared with this build's pin by the version it runs when running, else
 * by the one its settings name. */
export function driftOf(
  stack: Extract<StackOnHost, { kind: 'present' }>
): SwitchVersionDrift | null {
  const version = stack.runningVersion ?? stack.env.version;
  return version === null ? null : classifyVersionDrift(version, COMPATIBLE_SWITCH_VERSION);
}

/** Enough for the renderer to choose between Connect and Start, and nothing
 * secret. `busy` is the Console holding the stack's lock, if any. */
export function probeFromStack(
  hostLabel: string,
  stack: StackOnHost,
  busy: ServerLockHolder | null
): RemoteStackProbe {
  switch (stack.kind) {
    case 'absent':
      return { kind: 'absent', busy };
    case 'present':
      return {
        kind: 'present',
        running: stack.running,
        deployedVersion: stack.runningVersion ?? stack.env.version,
        shared: stack.published,
        drift: driftOf(stack),
        busy,
      };
    case 'unshared':
      return {
        kind: 'unshared',
        running: stack.running,
        ownerDir: stack.ownerDir,
        message: unsharedStackMessage(hostLabel, stack.ownerDir),
      };
    case 'incomplete':
      return { kind: 'incomplete', running: stack.running, missing: stack.missing };
    case 'unreadable':
      return { kind: 'unreadable', reason: stack.reason };
  }
}

function isRunning(resources: ProjectResources): boolean {
  return resources.containers.some(
    (container) => container.service === CORE_SERVICE && container.state === 'running'
  );
}

function fromEnvText(
  raw: string,
  source: StackEnvSource,
  resources: ProjectResources,
  published: boolean,
  stamp: string | null
): StackOnHost {
  const running = isRunning(resources);
  const reading = readStackEnv(raw);
  if (reading.kind === 'incomplete') {
    return { kind: 'incomplete', source, missing: reading.missing, raw, running };
  }
  return {
    kind: 'present',
    env: reading.env,
    raw,
    source,
    running,
    published,
    runningVersion: runningCoreVersion(resources),
    stamp,
  };
}

function runningCoreVersion(resources: ProjectResources): string | null {
  const core = resources.containers.find(
    (container) => container.service === CORE_SERVICE && container.state === 'running'
  );
  return core ? imageTag(core.image) : null;
}

/**
 * Trusted in this order: no containers or data means a first start, whatever
 * settings are lying about; then the published copy, unless stamped for a
 * database volume since recreated by a Console that does not publish; then
 * this account's own `.env`, only when nothing on the daemon says the stack
 * belongs to another account.
 */
export async function inspectStack(host: StackStateHost): Promise<StackOnHost> {
  let resources: ProjectResources;
  let published: PublishedCopy | null = null;
  // Asked once, and only when a stamp needs comparing with it.
  let database: string | null | undefined;
  let own: string | null;
  let ownStamp: string | null;
  try {
    [resources, own, ownStamp] = await Promise.all([
      listProjectResources(host),
      host.readFile(ENV_FILE_NAME),
      host.readFile(ENV_STAMP_FILE_NAME),
    ]);
    if (resources.stateVolume) published = await readPublishedCopy(host);
    if (published?.stamp) database = await databaseStamp(host, resources.dataVolumes);
  } catch (error) {
    return { kind: 'unreadable', reason: errorText(error) };
  }

  const hasProject = resources.containers.length > 0 || resources.dataVolumes.length > 0;
  if (!hasProject) return { kind: 'absent' };

  const running = isRunning(resources);
  // A copy with no stamp, or no database volume to compare it with, cannot be
  // judged and is trusted.
  const stale = published?.stamp != null && database != null && published.stamp !== database;
  if (published !== null && !stale) {
    return fromEnvText(published.env, 'published', resources, true, published.stamp);
  }
  if (stale) {
    log.warn(
      `stack-state: the published settings on ${host.label} were written for a database that ` +
        `has since been recreated, by a Console that does not share its settings; ignoring them`
    );
  }

  // Never published: it is ours only if this account created its containers.
  const foreignDir = resources.containers
    .map((container) => container.workingDir)
    .find((dir): dir is string => dir !== null && dir !== host.workingDir);
  if (foreignDir !== undefined) return { kind: 'unshared', ownerDir: foreignDir, running };
  if (own === null) return { kind: 'unshared', ownerDir: null, running };
  // A copy stamped for a database since recreated belongs to a stack that is
  // gone: a Console that does not share its settings reset it and started it
  // with its own credentials, leaving nothing else to say whose it is now.
  const stamp = ownStamp?.trim() || null;
  if (stamp !== null) {
    let current: string | null;
    try {
      current =
        database !== undefined ? database : await databaseStamp(host, resources.dataVolumes);
    } catch (error) {
      return { kind: 'unreadable', reason: errorText(error) };
    }
    if (current !== null && current !== stamp) {
      log.warn(
        `stack-state: this account's settings on ${host.label} were written for a database ` +
          `that has since been recreated elsewhere; not using them`
      );
      return { kind: 'unshared', ownerDir: null, running };
    }
  }
  return fromEnvText(own, 'working-dir', resources, false, stamp);
}
