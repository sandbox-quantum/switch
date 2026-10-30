import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import {
  composeDown,
  composeStop,
  composeUpService,
  runDocker,
  serviceContainerId,
} from '../compose';
import { STACK_HELPER_IMAGE } from '../constants';
import { classifyVersionDrift, readDeployedVersion } from '../deployed-version';
import { dockerExecutable } from '../docker';
import type { ServerHost } from '../host/types';
import { crossesMatrixBoundary } from '../matrix-migration';
import { managedSwitchVersion } from '../server-version';
import type { NativeLayout } from './native-paths';
import { DATABASE, OWNER_ROLE } from './postgres-cluster';
import { runCommand } from './run-command';

/**
 * Moving a local server from its Docker stack to the native runtime, data and
 * all.
 *
 * switch-core's database is exported with `pg_dump` inside the stack's own
 * Postgres container, then imported into the new native cluster with
 * `pg_restore` from a throwaway container of the same image: the portable PostgreSQL ships no client tools, and Docker is there by
 * definition while a Docker stack is being moved. Everything else carries over
 * by staying where it is: the credentials (the same secrets bundle) and the
 * ports (so agents keep their API URL).
 *
 * Nothing of the Docker stack is deleted. Its containers are removed but its
 * volumes stay, so a move that fails leaves a stack that simply starts again.
 */

const DATABASE_SERVICE = 'postgres';
const DUMP_TIMEOUT_MS = 30 * 60 * 1000;

export type DockerExport = {
  /** Directory holding the dumps; kept afterwards as the move's backup. */
  dir: string;
  /** `pg_dump -Fc` of each database the stack had, by database name. */
  dumps: { database: string; file: string }[];
  /** The switch-core version the stack was at, which the data matches. */
  deployedVersion: string;
};

/**
 * Why the Docker stack on `host` cannot be moved as it is, or null when it
 * can. Refuses what the move would get wrong rather than work around it: an
 * unreadable version, a stack newer than this build, and one still on the
 * Matrix transport, whose history only its own upgrade can copy out.
 */
export async function moveBlockedReason(host: ServerHost): Promise<string | null> {
  const deployed = await readDeployedVersion(host);
  if (deployed.kind === 'absent') return 'There is no Docker server here to move.';
  if (deployed.kind === 'unreadable') {
    return `Could not read which switch-core the Docker server runs (${deployed.reason}).`;
  }
  if (classifyVersionDrift(deployed.version, managedSwitchVersion())?.direction === 'downgrade') {
    return (
      `The Docker server runs switch-core ${deployed.version}, newer than the ` +
      `${managedSwitchVersion()} this Console runs. Update Switch Console first.`
    );
  }
  if (crossesMatrixBoundary(deployed.version, managedSwitchVersion())) {
    return (
      `The Docker server is still on switch-core ${deployed.version}, from before rooms moved ` +
      `out of Matrix. Start it once to update it, then move it.`
    );
  }
  return null;
}

async function databaseExists(host: ServerHost, container: string, database: string) {
  const out = await runDocker(
    host,
    [
      'exec',
      container,
      'sh',
      '-c',
      'psql -U "$POSTGRES_USER" -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = \'$1\'"',
      'sh',
      database,
    ],
    60_000
  );
  return out.trim() === '1';
}

/**
 * Pause the Docker stack and export its databases into the native layout's
 * backups, then take its containers down (volumes kept). Returns where the
 * dumps are.
 */
export async function exportDockerStack(
  host: ServerHost,
  layout: NativeLayout,
  onMessage: (message: string) => void
): Promise<DockerExport> {
  const deployed = await readDeployedVersion(host);
  if (deployed.kind !== 'deployed') {
    throw new Error('Could not read which switch-core the Docker server runs.');
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = path.join(layout.backups, `${stamp}-moved-from-docker-${deployed.version}`);
  await mkdir(dir, { recursive: true, mode: 0o700 });

  onMessage('Pausing the Docker server…');
  // Everything stops, so nothing writes while the data is exported; only its
  // database comes back up.
  await composeStop(host);
  await composeUpService(host, DATABASE_SERVICE);
  const container = await serviceContainerId(host, DATABASE_SERVICE);

  const dumps: DockerExport['dumps'] = [];
  for (const database of [DATABASE]) {
    if (!(await databaseExists(host, container, database))) {
      log.info(`local-switch-server: the Docker server has no ${database} database to move`);
      continue;
    }
    onMessage('Exporting the Switch database…');
    const inContainer = `/tmp/switch-move-${database}.dump`;
    const file = path.join(dir, `${database}.dump`);
    await runDocker(
      host,
      [
        'exec',
        container,
        'sh',
        '-c',
        'umask 077 && pg_dump -U "$POSTGRES_USER" -Fc -f "$1" "$2" && test -s "$1"',
        'sh',
        inContainer,
        database,
      ],
      DUMP_TIMEOUT_MS
    );
    await runDocker(host, ['cp', `${container}:${inContainer}`, file], DUMP_TIMEOUT_MS);
    await runDocker(host, ['exec', container, 'rm', '-f', inContainer], 60_000);
    dumps.push({ database, file });
  }
  if (!dumps.some((dump) => dump.database === DATABASE)) {
    throw new Error('The Docker server has no switch database to move.');
  }

  onMessage('Taking the Docker server down (its data stays)…');
  await composeDown(host, false);
  log.info(`local-switch-server: exported the Docker server to ${dir}`);
  return { dir, dumps, deployedVersion: deployed.version };
}

/**
 * Import the exported databases into the native cluster, running on
 * `postgresPort`, as its owner. The databases exist already, empty (the
 * cluster creates them); objects are recreated owned by the owner role, as
 * they were, with their grants to the runtime role. Any error fails the
 * import.
 */
export async function importIntoCluster(
  exported: DockerExport,
  postgresPort: number,
  ownerPassword: string,
  onMessage: (message: string) => void,
  onLog: (line: string) => void
): Promise<void> {
  // The client reaches the cluster on this machine's loopback: directly with
  // the host's network on Linux, through host.docker.internal on Docker
  // Desktop, which arrives from loopback.
  const linux = process.platform === 'linux';
  const network = linux
    ? ['--network', 'host']
    : ['--add-host', 'host.docker.internal:host-gateway'];
  const pgHost = linux ? '127.0.0.1' : 'host.docker.internal';
  for (const { database, file } of exported.dumps) {
    onMessage('Importing the Switch database…');
    await runCommand(
      dockerExecutable(),
      [
        'run',
        '--rm',
        ...network,
        '-v',
        `${exported.dir}:/dump:ro`,
        '-e',
        'PGPASSWORD',
        STACK_HELPER_IMAGE,
        'pg_restore',
        '-h',
        pgHost,
        '-p',
        String(postgresPort),
        '-U',
        OWNER_ROLE,
        '-d',
        database,
        '--no-owner',
        '--exit-on-error',
        `/dump/${path.basename(file)}`,
      ],
      {
        cwd: exported.dir,
        env: { ...process.env, PGPASSWORD: ownerPassword },
        onLine: onLog,
        timeoutMs: DUMP_TIMEOUT_MS,
      }
    );
  }
}
