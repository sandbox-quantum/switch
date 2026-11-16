import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { log } from '@main/lib/logger';
import type { DeployedVersion } from '../deployed-version';
import { errorText } from '../error-text';
import {
  backupDirectoryName,
  backupMessage,
  backupReason,
  type UpgradeSource,
} from '../managed-upgrade';
import type { NativeLayout } from './native-paths';
import { clusterExists } from './postgres-cluster';

/** What was last started here: the version the database has been (or is
 * being) migrated to. Written before switch-core boots, as the Docker stack
 * writes `SWITCH_VERSION` into `.env` before `compose up`. */
const DEPLOYED_FILE = 'deployed.json';

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

export async function writeNativeDeployedVersion(
  layout: NativeLayout,
  version: string
): Promise<void> {
  await writeFile(
    path.join(layout.run, DEPLOYED_FILE),
    `${JSON.stringify({ version }, null, 2)}\n`
  );
}

/**
 * Copy the data directory aside before switch-core migrates it. The cluster
 * is stopped by then, so a file copy is a consistent backup — and it needs no
 * `pg_dump`, which the portable build does not ship.
 */
export async function backupDataDirectory(
  layout: NativeLayout,
  from: string | null,
  onMessage: (message: string) => void
): Promise<string> {
  onMessage(backupMessage(from));
  const directory = path.join(layout.backups, backupDirectoryName(from));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await cp(layout.pgdata, path.join(directory, 'pgdata'), { recursive: true });
  await writeFile(
    path.join(directory, 'README.txt'),
    [
      backupReason(from),
      '',
      'pgdata/   a copy of the PostgreSQL data directory, taken with the server stopped',
      '',
      'Keep it private: it holds every message and credential the server stored. To go back,',
      `stop the server, replace ${layout.pgdata} with this copy, and run switch-core ` +
        `${from ?? 'the version that last ran it'}.`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  log.info(`local-switch-server: backed up the database to ${directory} before starting`);
  return directory;
}

/** Where a native server's version record and database are, for the backup
 * an update — or a start with no version record — takes first. */
export function nativeUpgradeSource(layout: NativeLayout): UpgradeSource {
  return {
    readDeployedVersion: () => readNativeDeployedVersion(layout),
    databaseExists: () => clusterExists(layout),
    backupDatabase: (from, message) => backupDataDirectory(layout, from, message),
  };
}
