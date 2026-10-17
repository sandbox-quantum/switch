import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { assertManagedServerUrlFree } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import {
  COMPATIBLE_SWITCH_VERSION,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
} from '@shared/app-identity';
import {
  CHECKOUT_IMAGE_TAG,
  type DeployedTelemetry,
  type StartLocalServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { ManagedServerRef } from '@shared/core/switch-servers/switch-servers';
import { currentFlintEnv } from '../../telemetry/config';
import { currentInternalFlag } from '../../telemetry/internal-account';
import { classifyVersionDrift, type DeployedVersion } from '../deployed-version';
import { detectDocker } from '../docker';
import { envFlag, readEnvValue, TELEMETRY_ENABLED_KEY } from '../env-file';
import { errorText } from '../error-text';
import type { LocalServerPorts } from '../free-port';
import { waitForHealth } from '../health';
import type { ServerHost } from '../host/types';
import {
  finishUpgrade,
  type OwedUpgrade,
  prepareUpgradeFrom,
  type UpgradeJournal,
} from '../managed-upgrade';
import { registerManagedServer } from '../pipeline';
import { clearPorts, resolvePorts } from '../ports';
import { clearSecrets, loadOrCreateSecrets } from '../secrets';
import { telemetryConsent } from '../telemetry-consent';
import { CORE_ENV_FILE, coreLogTail, runningCore, startCore, stopCore } from './core-process';
import { buildNativeCoreSettings, nativeApiUrl } from './core-settings';
import { startMattermost, stopMattermost } from './mattermost';
import type { NativeLayout } from './native-paths';
import {
  findPostgresForCluster,
  type PostgresBinaries,
  resolvePostgres,
} from './postgres-binaries';
import {
  clusterExists,
  initCluster,
  startCluster,
  stopCluster,
  stopClusterByPid,
  syncPasswords,
  writeClusterConfig,
} from './postgres-cluster';
import { installSwitchCore, pruneSwitchCoreInstalls } from './switch-core-install';
import { resolveUv } from './uv';

/** What was last started here: the version the database has been (or is
 * being) migrated to. Written before switch-core boots, as the Docker stack
 * writes `SWITCH_VERSION` into `.env` before `compose up`. */
const DEPLOYED_FILE = 'deployed.json';

export type NativeStartOptions = {
  /** Files (ports, journal) and the secrets key, shared with the Docker mode. */
  host: ServerHost;
  layout: NativeLayout;
  ref: ManagedServerRef;
  serverName: string;
  activate: boolean;
  onMessage: (message: string) => void;
  onLog: (line: string) => void;
  onUpgrade: (upgrade: OwedUpgrade) => void;
  signal: AbortSignal;
  /** Dev-only: run switch-core from this checkout's `core/`. */
  checkoutRoot: string | null;
  /** Whether to run Mattermost beside the server (needs Docker). */
  mattermost: boolean;
};

export async function readNativeDeployedVersion(layout: NativeLayout): Promise<DeployedVersion> {
  let raw: string;
  try {
    raw = await readFile(path.join(layout.run, DEPLOYED_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      return { kind: 'unreadable', reason: errorText(error) };
    }
    // No record, but a cluster: something started it that this build cannot
    // date, which must not read as a fresh install.
    if (await clusterExists(layout)) {
      return {
        kind: 'unreadable',
        reason: `${DEPLOYED_FILE} is missing beside an existing database`,
      };
    }
    return { kind: 'absent' };
  }
  try {
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === 'string' && parsed.version.length > 0) {
      return { kind: 'deployed', version: parsed.version, source: 'env-file' };
    }
  } catch {}
  return { kind: 'unreadable', reason: `${DEPLOYED_FILE} does not name a version` };
}

async function writeDeployedVersion(layout: NativeLayout, version: string): Promise<void> {
  await writeFile(
    path.join(layout.run, DEPLOYED_FILE),
    `${JSON.stringify({ version }, null, 2)}\n`
  );
}

/** Whether `port` can be bound on loopback right now. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * Refuse a start whose ports something else has taken since they were chosen,
 * in the words a failed bind uses, so the start-failure explainer offers to
 * move the server to another port.
 */
async function assertPortsFree(ports: LocalServerPorts): Promise<void> {
  for (const port of [ports.api, ports.postgres]) {
    if (!(await portFree(port))) {
      throw new Error(`bind 127.0.0.1:${port}: address already in use`);
    }
  }
}

/**
 * Copy the data directory aside before switch-core migrates it. The cluster
 * is stopped by then, so a file copy is a consistent backup — and it needs no
 * `pg_dump`, which the portable build does not ship.
 */
async function backupDataDirectory(
  layout: NativeLayout,
  from: string,
  onMessage: (message: string) => void
): Promise<string> {
  onMessage(
    `Backing up the database before updating switch-core ${from} → ${COMPATIBLE_SWITCH_VERSION}…`
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = path.join(layout.backups, `${stamp}-switch-core-${from}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(layout.pgdata, path.join(directory, 'pgdata'), { recursive: true });
  await writeFile(
    path.join(directory, 'README.txt'),
    [
      `Switch Console took this backup before updating the Switch server from switch-core ${from} to ${COMPATIBLE_SWITCH_VERSION}.`,
      '',
      'pgdata/   a copy of the PostgreSQL data directory, taken with the server stopped',
      '',
      'Keep it private: it holds every message and credential the server stored. To go back,',
      `stop the server, replace ${layout.pgdata} with this copy, and run switch-core ${from}.`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  log.info(`local-switch-server: backed up the database to ${directory} before updating`);
  return directory;
}

/** Stop whatever of the server is running, switch-core first so it is not
 * left talking to a database that has gone. */
async function stopProcesses(
  layout: NativeLayout,
  binaries: PostgresBinaries | null,
  onLog: (line: string) => void
): Promise<void> {
  await stopMattermost(layout, false);
  await stopCore(layout);
  if (binaries !== null && (await clusterExists(layout))) {
    await stopCluster(binaries, layout, onLog);
  }
}

/**
 * Start (or restart) the native local server at this build's pin.
 *
 * Fetches what is missing — PostgreSQL and uv when the machine has none, and
 * this version of switch-core — creates the database on first start, backs it
 * up before an update, then starts PostgreSQL and switch-core in the
 * background and waits for the gateway to answer before registering the
 * server and signing in, as the Docker pipeline does.
 */
export async function startNativeStack(opts: NativeStartOptions): Promise<StartLocalServerResult> {
  const { host, layout, ref, serverName, activate, onMessage, onLog, onUpgrade, signal } = opts;
  const { checkoutRoot, mattermost } = opts;
  await mkdir(layout.run, { recursive: true });

  const secrets = await loadOrCreateSecrets(host);
  const ports = await resolvePorts(host);
  const apiUrl = nativeApiUrl(ports.api);
  await assertManagedServerUrlFree(apiUrl, ref);

  onMessage('Checking the deployed version…');
  const deployed = await readNativeDeployedVersion(layout);
  if (
    checkoutRoot === null &&
    deployed.kind === 'deployed' &&
    deployed.version !== CHECKOUT_IMAGE_TAG
  ) {
    const drift = classifyVersionDrift(deployed.version, COMPATIBLE_SWITCH_VERSION);
    if (drift?.direction === 'downgrade') {
      return { kind: 'version-downgrade', deployed: drift.deployed, expected: drift.expected };
    }
  }

  const uv = await resolveUv(layout, onMessage);
  const postgres = await resolvePostgres(layout, onMessage);
  const install = await installSwitchCore({
    layout,
    uv,
    version: COMPATIBLE_SWITCH_VERSION,
    owner: RELEASE_REPO_OWNER,
    repo: RELEASE_REPO_NAME,
    checkoutRoot,
    onMessage,
  });

  onMessage('Stopping the running server…');
  await stopProcesses(layout, postgres, onLog);
  await assertPortsFree(ports);

  const passwords = { owner: secrets.dbPassword, runtime: secrets.dbRuntimePassword };
  let upgrade: UpgradeJournal | null = null;
  if (await clusterExists(layout)) {
    upgrade = await prepareUpgradeFrom(host, checkoutRoot, onMessage, onUpgrade, {
      readDeployedVersion: () => readNativeDeployedVersion(layout),
      backupDatabase: (from, message) => backupDataDirectory(layout, from, message),
    });
    await syncPasswords(postgres, layout, passwords, onLog);
  } else {
    onMessage(`Creating the database (PostgreSQL ${postgres.major})…`);
    await initCluster(postgres, layout, passwords, onLog);
    await writeDeployedVersion(layout, install.version);
  }
  await writeClusterConfig(layout, ports.postgres);
  onMessage('Starting PostgreSQL…');
  await startCluster(postgres, layout, onLog);
  // From here a failure leaves processes behind that nothing would stop; a
  // failed start stops them again, so it does not look half-running.
  try {
    const telemetryEnabled = await telemetryConsent();
    const settings = buildNativeCoreSettings({
      apiPort: ports.api,
      postgresPort: ports.postgres,
      // No dashboard process runs natively, so the port set aside for one
      // carries the callback listener instead of a fifth port being added.
      callbackPort: ports.gateway,
      secrets,
      telemetryEnabled,
      telemetryEnvironment: currentFlintEnv(),
      telemetryInternal: (await currentInternalFlag()) === 'true',
    });
    await writeDeployedVersion(layout, install.version);
    onMessage('Starting switch-core…');
    const record = await startCore(layout, install, settings);
    log.info(`local-switch-server: started switch-core ${install.version} (pid ${record.pid})`);

    onMessage('Waiting for the server to become healthy…');
    const healthy = await waitForHealth(apiUrl, { signal });
    if (!healthy) {
      const alive = (await runningCore(layout)) !== null;
      const tail = await coreLogTail(layout, 3);
      await stopAfterFailedStart(layout, postgres);
      return {
        kind: 'error',
        message:
          `${alive ? 'switch-core did not become healthy in time' : 'switch-core stopped during startup'}.` +
          (tail ? ` Its log ends:\n${tail}` : '') +
          `\nFull log: ${path.join(layout.logs, 'switch-core.log')}`,
      };
    }

    const serverId = await registerManagedServer(
      ref,
      serverName,
      { gatewayUrl: apiUrl, apiUrl },
      secrets,
      activate,
      onMessage
    );
    if (upgrade) await finishUpgrade(host);

    let warning: string | null = null;
    if (mattermost) {
      const docker = await detectDocker();
      if (!docker.available) {
        warning =
          'Mattermost is turned on, but Docker is not available, so the server is running ' +
          `without it. ${docker.detail}`;
        log.warn(`local-switch-server: ${warning}`);
      } else {
        try {
          await startMattermost({
            layout,
            install,
            secrets,
            apiUrl,
            mattermostPort: ports.mattermost,
            postgresPort: ports.postgres,
            callbackPort: ports.gateway,
            onMessage,
            onLog,
          });
        } catch (error) {
          log.error('local-switch-server: Mattermost did not start', { error: String(error) });
          warning = `The server is running, but Mattermost could not be set up: ${errorText(error)}`;
        }
      }
    }

    if (checkoutRoot === null) {
      await pruneSwitchCoreInstalls(layout, install.version).catch((error: unknown) => {
        log.warn('local-switch-server: could not remove old switch-core installs', {
          error: String(error),
        });
      });
    }
    return { kind: 'started', serverId, telemetryEnabled, warning };
  } catch (error) {
    await stopAfterFailedStart(layout, postgres);
    throw error;
  }
}

/** Stop what a failed start left running. Best effort: the start's own
 * failure is what gets reported, and this one is logged beside it. */
async function stopAfterFailedStart(layout: NativeLayout, postgres: PostgresBinaries) {
  await stopProcesses(layout, postgres, () => {}).catch((error: unknown) => {
    log.error('local-switch-server: could not stop the server after a failed start', {
      error: String(error),
    });
  });
}

/** Stop the server. Never downloads anything: when the PostgreSQL that runs
 * the cluster cannot be found, its postmaster is signalled directly. */
export async function stopNativeStack(layout: NativeLayout): Promise<void> {
  const binaries = await findPostgresForCluster(layout);
  await stopProcesses(layout, binaries, () => {});
  if (binaries === null) await stopClusterByPid(layout);
}

/**
 * Stop the server and delete its database, logs and credentials, so the next
 * start is a fresh install. Downloaded tools and update backups are kept: the
 * one costs a download to replace, and the other is the user's.
 */
export async function resetNativeStack(host: ServerHost, layout: NativeLayout): Promise<void> {
  await stopNativeStack(layout);
  // Its schema goes with the cluster below; only its uploaded files are in the
  // volume. Without Docker they cannot be removed, which is said, not hidden.
  await stopMattermost(layout, true).catch((error: unknown) => {
    log.error('local-switch-server: could not remove Mattermost’s files volume', {
      error: String(error),
    });
  });
  for (const dir of [layout.pgdata, `${layout.pgdata}.init`, layout.run, layout.logs]) {
    await rm(dir, { recursive: true, force: true });
  }
  await clearSecrets(host);
  await clearPorts(host);
  await finishUpgrade(host);
}

export async function nativeStackRunning(layout: NativeLayout): Promise<boolean> {
  return (await runningCore(layout)) !== null;
}

export async function nativeStartedAt(layout: NativeLayout): Promise<string | null> {
  return (await runningCore(layout))?.startedAt ?? null;
}

/** What the running switch-core does about usage data, read from the
 * environment it was started with — which is what it read at boot. */
export async function readNativeTelemetry(layout: NativeLayout): Promise<DeployedTelemetry> {
  try {
    const env = await readFile(path.join(layout.run, CORE_ENV_FILE), 'utf8');
    return { known: true, enabled: envFlag(readEnvValue(env, TELEMETRY_ENABLED_KEY)) };
  } catch (error) {
    return { known: false, reason: `${CORE_ENV_FILE}: ${errorText(error)}` };
  }
}
