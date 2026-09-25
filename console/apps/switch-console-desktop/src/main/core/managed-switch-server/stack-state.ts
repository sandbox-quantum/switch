import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import type { RemoteStackProbe } from '@shared/core/managed-switch-server/managed-switch-server';
import {
  ENV_FILE_NAME,
  STACK_HELPER_IMAGE,
  STACK_STATE_LABEL,
  STACK_STATE_VOLUME_SUFFIX,
} from './constants';
import { classifyVersionDrift } from './deployed-version';
import { readStackEnv, type StackEnv } from './env-file';
import type { ServerHost } from './host/types';

/**
 * What a remote host has of a Switch Console-managed stack, read off the host
 * itself rather than out of this desktop's store (CHOO-2893).
 *
 * A stack on a shared VM is used by everyone with access to that VM, from their
 * own Consoles and often under their own accounts. Every one of them needs the
 * ports it publishes and the credentials its volumes were created with: a
 * Console without them would generate its own, rewrite the stack's `.env` with
 * them, and lock the stack out of its own database. The host is the one place
 * every Console can reach, so the host is the source of truth, and each
 * desktop's copy is a cache of it.
 *
 * Two places on the host hold that truth:
 *
 * - **The published copy**: the `.env` the stack was last started with, kept in
 *   a Docker volume beside the stack's own (see `STACK_STATE_VOLUME_SUFFIX`).
 *   Every account that can run the stack can reach the daemon, so every
 *   account can read it. It is written after every start, from whichever
 *   Console did the starting.
 * - **This account's working dir**, where the `.env` compose actually reads
 *   lives. It is the only copy a stack started before publishing existed has,
 *   and it is readable only to the account that started it.
 *
 * Running compose from a second account's working dir with a byte-identical
 * `.env` leaves the containers alone — measured, and it follows from the
 * bundled compose file referencing nothing by path — so publishing one `.env`
 * that every Console then writes verbatim is what lets several accounts run
 * one stack.
 */

/** What stack-state work needs of a host: run docker there, read its own
 * working dir, and hand a command a secret on stdin. Only the remote host
 * shares its stack, so only it provides this. */
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

/** The core service whose container stands for "the stack is up", as
 * `isStackRunning` in compose.ts. */
const CORE_SERVICE = 'switch';

/** Inside the state volume. */
const STATE_MOUNT = '/state';
const PUBLISHED_ENV_FILE = 'stack.env';
/** Beside the published copy: which database volume it was written for. */
const PUBLISHED_STAMP_FILE = 'stack.db';
/** Separates the copy from its stamp when both come back from one read. */
const STAMP_MARKER = '---switch-console-stamp---';

/** The compose volume holding the stack's Postgres data, whose credentials the
 * published copy has to match. */
const DATABASE_VOLUME = 'pgdata';

const QUICK_TIMEOUT_MS = 60_000;
/** A host that has never run the stack has to pull the helper image first. */
const PULL_TIMEOUT_MS = 10 * 60_000;

export function stackStateVolume(host: Pick<StackStateHost, 'composeProjectName'>): string {
  return `${host.composeProjectName}_${STACK_STATE_VOLUME_SUFFIX}`;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Run `docker <args>` on the host, returning stdout. Failures name the host
 * and carry docker's own complaint. Nothing passed here may be a secret: the
 * arguments are visible in the host's process table. */
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
    const stderr = (error as { stderr?: string } | undefined)?.stderr?.trim();
    throw new Error(`docker ${args[0]} on ${host.label} failed: ${stderr || errorText(error)}`);
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
  /** The directory compose was run from when it created this container — the
   * working dir of the account that started it. Null when the label is absent. */
  workingDir: string | null;
};

export type ProjectResources = {
  /** Every container of the stack's compose project, stopped ones included. */
  containers: ProjectContainer[];
  /** The stack's own named volumes — Postgres and Mattermost data. */
  dataVolumes: string[];
  /** Whether the shared state volume exists. */
  stateVolume: boolean;
};

/**
 * Everything the stack's compose project has on the host's daemon, found by
 * label rather than through a compose file — so it sees a stack another
 * account started from a working dir this one cannot read.
 */
export async function listProjectResources(host: StackStateHost): Promise<ProjectResources> {
  // Independent questions, asked at once: each is an SSH round trip.
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
      `{{.Label "${COMPOSE_SERVICE_LABEL}"}}\t{{.State}}\t{{.Label "${COMPOSE_WORKING_DIR_LABEL}"}}`,
    ])
  ).map((line) => {
    const [service = '', state = '', workingDir = ''] = line.split('\t');
    return { service, state, workingDir: workingDir || null };
  });
}

/** Whether the shared state volume exists — the one question a read of the
 * register or a withdrawal needs answered before touching it. */
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

/** The stack's own named volumes — Postgres and Mattermost data. */
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

/**
 * When the stack's database volume was created, as the daemon records it, or
 * null when there is no such volume. It changes exactly when the volume is
 * recreated — which is what a reset does — so it tells a published copy
 * written for this database from one left over from the database before.
 */
async function databaseStamp(host: StackStateHost, dataVolumes: string[]): Promise<string | null> {
  const volume = `${host.composeProjectName}_${DATABASE_VOLUME}`;
  if (!dataVolumes.includes(volume)) return null;
  const stamp = await docker(host, ['volume', 'inspect', '--format', '{{.CreatedAt}}', volume]);
  return stamp.trim() || null;
}

/** Hosts, by label, already known to have the helper image. A host keeps an
 * image it has, and `docker run` pulls one that has since been removed, so
 * each is asked once per run of this Console rather than before every read. */
const hostsWithHelperImage = new Set<string>();

/** Pull the helper image when this host does not have it yet. */
async function ensureHelperImage(host: StackStateHost): Promise<void> {
  if (hostsWithHelperImage.has(host.label)) return;
  try {
    await docker(host, ['image', 'inspect', '--format', '{{.Id}}', STACK_HELPER_IMAGE]);
    hostsWithHelperImage.add(host.label);
    return;
  } catch {
    // Absent (or unreadable, which the pull will report properly).
  }
  await docker(host, ['pull', '--quiet', STACK_HELPER_IMAGE], PULL_TIMEOUT_MS);
  hostsWithHelperImage.add(host.label);
}

/**
 * Run a shell `script` in a throwaway container with the state volume mounted
 * read-only at `/state`, returning its stdout. The volume must already exist —
 * `docker run -v` would otherwise create it, and reading must not.
 */
export async function readStateVolume(host: StackStateHost, script: string): Promise<string> {
  await ensureHelperImage(host);
  return docker(host, [
    'run',
    '--rm',
    '--network',
    'none',
    '--volume',
    `${stackStateVolume(host)}:${STATE_MOUNT}:ro`,
    '--entrypoint',
    'sh',
    STACK_HELPER_IMAGE,
    '-c',
    script,
    'stack-state',
  ]);
}

/** Create the state volume if it is not there yet. Idempotent. */
async function ensureStateVolume(host: StackStateHost): Promise<void> {
  await docker(host, [
    'volume',
    'create',
    '--label',
    `${STACK_STATE_LABEL}=${host.composeProjectName}`,
    stackStateVolume(host),
  ]);
}

/**
 * Run a shell `script` against the state volume with `input` on its stdin.
 * Input is the only way a secret reaches it, for the reason
 * `writeCommandInput` gives; `scriptArgs` arrive as `$1…`, so no value is
 * spliced into the script's text. Creates the volume on first use.
 */
export async function writeStateVolume(
  host: StackStateHost,
  script: string,
  input: string,
  scriptArgs: string[]
): Promise<void> {
  await ensureHelperImage(host);
  await ensureStateVolume(host);
  await host.writeCommandInput(
    host.dockerBin,
    [
      'run',
      '--rm',
      '--interactive',
      '--network',
      'none',
      '--volume',
      `${stackStateVolume(host)}:${STATE_MOUNT}`,
      '--entrypoint',
      'sh',
      STACK_HELPER_IMAGE,
      '-c',
      script,
      'stack-state',
      ...scriptArgs,
    ],
    input,
    { timeoutMs: QUICK_TIMEOUT_MS }
  );
}

/** The published `.env`, and the database volume it was written for (null
 * when that was not recorded). */
export type PublishedCopy = { env: string; stamp: string | null };

/** The published copy, or null when the volume holds none. */
export async function readPublishedCopy(host: StackStateHost): Promise<PublishedCopy | null> {
  const out = await readStateVolume(
    host,
    `cat "${STATE_MOUNT}/${PUBLISHED_ENV_FILE}" 2>/dev/null; printf '\\n%s\\n' '${STAMP_MARKER}'; ` +
      `cat "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}" 2>/dev/null; true`
  );
  // The marker is printed after a newline of its own, so taking exactly that
  // one back off leaves the copy byte for byte as it was published.
  const split = out.lastIndexOf(`\n${STAMP_MARKER}`);
  const env = split === -1 ? out : out.slice(0, split);
  const stamp = split === -1 ? '' : out.slice(split + 1 + STAMP_MARKER.length).trim();
  if (env.trim().length === 0) return null;
  return { env, stamp: stamp || null };
}

/** Reads the stamp from stdin's first line and the copy from the rest. */
const PUBLISH_SCRIPT = [
  'set -e',
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
 * Publish `env` as the stack's shared copy, replacing any earlier one
 * atomically, readable only through the daemon. Called on every start with
 * the exact file that start gives compose.
 *
 * Stamped with the database volume it is for, when there is one yet — a first
 * start publishes before compose creates it, and stamps after, with
 * {@link stampPublishedEnv}. A stamp from before is removed rather than left
 * to vouch for a copy it was not written with. The copy is written before its
 * stamp, so a read between the two sees a mismatch and distrusts it, never
 * the other way round.
 */
export async function publishEnv(host: StackStateHost, env: string): Promise<void> {
  const stamp = await databaseStamp(host, await listDataVolumes(host));
  await writeStateVolume(host, PUBLISH_SCRIPT, `${stamp ?? ''}\n${env}`, []);
}

/**
 * Stamp the published copy with the database volume a start has just
 * created, which did not exist when the copy was published. Without it a
 * first start's copy vouches for nothing, and a later reset from a Console
 * that does not publish would leave it looking current.
 */
export async function stampPublishedEnv(host: StackStateHost): Promise<void> {
  const stamp = await databaseStamp(host, await listDataVolumes(host));
  if (stamp === null) {
    log.warn(
      `stack-state: the stack on ${host.label} has no database volume after starting, ` +
        `so its published settings are not stamped with one`
    );
    return;
  }
  await writeStateVolume(
    host,
    `umask 077 && IFS= read -r stamp && ` +
      `printf "%s\\n" "$stamp" > "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp" && ` +
      `mv "${STATE_MOUNT}/.${PUBLISHED_STAMP_FILE}.tmp" "${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
    `${stamp}\n`,
    []
  );
}

/**
 * Take the published copy away, for a reset: the credentials in it die with
 * the data volumes, and leaving them would have the next Console adopt
 * credentials that open nothing. Everything else in the volume — the activity
 * record above all — is kept.
 */
export async function withdrawPublishedEnv(host: StackStateHost): Promise<void> {
  if (!(await stateVolumeExists(host))) return;
  await writeStateVolume(
    host,
    `rm -f "${STATE_MOUNT}/${PUBLISHED_ENV_FILE}" "${STATE_MOUNT}/.${PUBLISHED_ENV_FILE}.tmp" ` +
      `"${STATE_MOUNT}/${PUBLISHED_STAMP_FILE}"`,
    '',
    []
  );
}

/** Where the settings a stack runs with were read from. */
export type StackEnvSource = 'published' | 'working-dir';

export type StackOnHost =
  /** Nothing of the stack's project on this daemon — no containers, no data:
   * a first start, and the only case where new credentials may be made. */
  | { kind: 'absent' }
  /** The stack's settings, readable by this account. `published` says whether
   * other accounts can read them too — false for a stack started before
   * publishing existed, which the next start or connect publishes. */
  | {
      kind: 'present';
      env: StackEnv;
      /** The exact `.env` text, so what gets published is what compose read. */
      raw: string;
      source: StackEnvSource;
      running: boolean;
      published: boolean;
    }
  /** Someone else's stack that this account cannot read the settings of: it
   * was started from another account's working dir and never published.
   * `ownerDir` is that working dir when the containers still say it. Starting
   * here would recreate that stack with new credentials, so nothing may. */
  | { kind: 'unshared'; ownerDir: string | null; running: boolean }
  /** A `.env` was found but does not carry everything the stack needs. `raw`
   * is its text, so a start can check a copy of the settings against what it
   * does carry before filling the gaps from that copy. */
  | {
      kind: 'incomplete';
      source: StackEnvSource;
      missing: string[];
      raw: string;
      running: boolean;
    }
  /** The host could not be asked. Distinct from `absent`, for the reason
   * `readDeployedVersion` keeps them apart: an unreachable daemon is not an
   * empty host. */
  | { kind: 'unreadable'; reason: string };

/**
 * Why this account may neither start nor join a stack another account set up
 * and never shared — and what fixes it, which is not something this account
 * can do.
 */
export function unsharedStackMessage(hostLabel: string, ownerDir: string | null): string {
  const where = ownerDir ? ` (from ${ownerDir})` : '';
  return (
    `The Switch server on ${hostLabel} was set up from another account${where} and its settings ` +
    `have not been shared, so this account cannot read them. Starting it from here would ` +
    `replace its credentials and take it down, so nothing was changed. It is shared the next ` +
    `time an up-to-date Switch Console starts or connects to it from the account that set it up.`
  );
}

/** What the renderer is told of a host's stack: enough to choose between
 * Connect and Start, and nothing secret. */
export function probeFromStack(hostLabel: string, stack: StackOnHost): RemoteStackProbe {
  switch (stack.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'present':
      return {
        kind: 'present',
        running: stack.running,
        deployedVersion: stack.env.version,
        shared: stack.published,
        drift:
          stack.env.version === null
            ? null
            : classifyVersionDrift(stack.env.version, COMPATIBLE_SWITCH_VERSION),
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
  running: boolean,
  published: boolean
): StackOnHost {
  const reading = readStackEnv(raw);
  if (reading.kind === 'incomplete') {
    return { kind: 'incomplete', source, missing: reading.missing, raw, running };
  }
  return { kind: 'present', env: reading.env, raw, source, running, published };
}

/**
 * Find out what this host has of the stack, in the order that can be trusted:
 *
 * 1. nothing of the stack's project on the daemon — no containers, no data —
 *    which is a first start whatever settings are lying about: a `.env` or a
 *    published copy with no stack behind it belongs to one that was reset or
 *    removed, and the credentials in it open nothing;
 * 2. the published copy, which every account shares and every start refreshes
 *    — unless it was written for a database volume that is no longer there:
 *    a Console from before settings were shared can reset the stack and start
 *    it with new credentials without knowing the copy exists, and the copy
 *    then names credentials that open nothing;
 * 3. this account's own `.env`, but only when nothing on the daemon says the
 *    stack belongs to another account — a stale file left from before someone
 *    else reset and restarted the stack would otherwise be taken for the truth.
 */
export async function inspectStack(host: StackStateHost): Promise<StackOnHost> {
  let resources: ProjectResources;
  let published: PublishedCopy | null = null;
  let database: string | null = null;
  let own: string | null;
  try {
    [resources, own] = await Promise.all([
      listProjectResources(host),
      host.readFile(ENV_FILE_NAME),
    ]);
    if (resources.stateVolume) published = await readPublishedCopy(host);
    if (published?.stamp) database = await databaseStamp(host, resources.dataVolumes);
  } catch (error) {
    return { kind: 'unreadable', reason: errorText(error) };
  }

  const hasProject = resources.containers.length > 0 || resources.dataVolumes.length > 0;
  if (!hasProject) return { kind: 'absent' };

  const running = isRunning(resources);
  // A copy with no stamp, or a stack with no database volume to compare it
  // with, cannot be judged, and is trusted as it always was.
  const stale = published?.stamp != null && database !== null && published.stamp !== database;
  if (published !== null && !stale) return fromEnvText(published.env, 'published', running, true);
  if (stale) {
    log.warn(
      `stack-state: the published settings on ${host.label} were written for a database that ` +
        `has since been recreated, by a Console that does not share its settings; ignoring them`
    );
  }

  // The stack exists and was never published: it is ours only if the account
  // that created its containers is this one.
  const foreignDir = resources.containers
    .map((container) => container.workingDir)
    .find((dir): dir is string => dir !== null && dir !== host.workingDir);
  if (foreignDir !== undefined) return { kind: 'unshared', ownerDir: foreignDir, running };
  if (own === null) return { kind: 'unshared', ownerDir: null, running };
  return fromEnvText(own, 'working-dir', running, false);
}
