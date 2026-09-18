import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { compareVersions } from '@main/lib/semver';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import { CHECKOUT_IMAGE_TAG } from '@shared/core/managed-switch-server/managed-switch-server';
import { COMPOSE_FILE_NAME, ENV_FILE_NAME } from './constants';
import { classifyVersionDrift, readDeployedVersion } from './deployed-version';
import { restrictWindowsFileToOwner } from './host/local-host';
import type { ServerHost } from './host/types';

const JOURNAL = 'upgrade.json';
const journalSchema = z.object({ from: z.string(), to: z.string(), backup: z.string() });

export async function hasPendingLocalUpgrade(host: ServerHost): Promise<boolean> {
  return (await host.readFile(JOURNAL)) !== null;
}

/** Save a database dump before anything rewrites the old stack's configuration.
 * The journal survives partial Compose updates and is cleared only after the
 * new server authenticates and advertises the required session contract. */
export async function prepareLocalUpgrade(
  host: ServerHost,
  checkoutRoot: string | null,
  onMessage: (message: string) => void
): Promise<void> {
  if (host.kind !== 'local') throw new Error('Local upgrade called for a remote server.');
  const pending = await host.readFile(JOURNAL);
  if (pending) {
    const journal = journalSchema.parse(JSON.parse(pending));
    const order = compareVersions(journal.to, COMPATIBLE_SWITCH_VERSION);
    if (order === null || order > 0) {
      throw new Error(
        `An interrupted update requires Switch server ${journal.to}. Install the newer app to finish it. Your database backup is in ${journal.backup}.`
      );
    }
  }
  const deployed = await readDeployedVersion(host);
  if (checkoutRoot !== null) return;
  if (
    deployed.kind === 'unreadable' ||
    (deployed.kind === 'deployed' && deployed.version === CHECKOUT_IMAGE_TAG)
  ) {
    throw new Error(
      'Could not safely determine the installed server version. Check Docker and the server configuration before retrying.'
    );
  }
  if (deployed.kind === 'absent') {
    if (pending)
      throw new Error(
        'The interrupted update’s server configuration is missing. Restore it from the database backup directory before retrying.'
      );
    return;
  }
  const drift = classifyVersionDrift(deployed.version, COMPATIBLE_SWITCH_VERSION);
  if (drift && drift.direction !== 'upgrade') {
    throw new Error(
      drift.direction === 'downgrade'
        ? `This server is newer than this app. Update Switch Console to continue; its database cannot be downgraded.`
        : 'The installed server version cannot be compared safely. Check its configuration before updating.'
    );
  }
  if (pending || !drift) return;

  onMessage('Backing up your local server database…');
  const relative = `backups/${Date.now()}-${randomUUID()}`;
  const directory = join(host.workingDir, relative);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') await restrictWindowsFileToOwner(directory);
  for (const file of [COMPOSE_FILE_NAME, ENV_FILE_NAME]) {
    const content = await host.readFile(file);
    if (content === null) throw new Error(`Cannot back up the server: ${file} is missing.`);
    await host.writeFile(`${relative}/${file}`, content, 0o600);
  }
  const args = [
    'compose',
    '-f',
    COMPOSE_FILE_NAME,
    '--env-file',
    ENV_FILE_NAME,
    '--project-name',
    host.composeProjectName,
  ];
  await host.ctx.exec(host.dockerBin, [...args, 'up', '-d', '--no-deps', '--wait', 'postgres'], {
    timeout: 120_000,
  });
  const { stdout } = await host.ctx.exec(host.dockerBin, [...args, 'ps', '-q', 'postgres'], {
    timeout: 30_000,
  });
  const container = stdout.trim();
  if (!/^[a-f0-9]+$/.test(container))
    throw new Error('Could not identify the local database container for backup.');
  const dump = `/tmp/switch-upgrade-${randomUUID()}.sql`;
  await host.ctx.exec(
    host.dockerBin,
    [
      'exec',
      container,
      'sh',
      '-c',
      'umask 077; exec pg_dumpall -U "$POSTGRES_USER" -f "$1"',
      'sh',
      dump,
    ],
    { timeout: 300_000 }
  );
  const destination = join(directory, 'database.sql');
  await host.ctx.exec(host.dockerBin, ['cp', `${container}:${dump}`, destination], {
    timeout: 300_000,
  });
  await chmod(destination, 0o600);
  if (process.platform === 'win32') await restrictWindowsFileToOwner(destination);
  await host.ctx.exec(host.dockerBin, ['exec', container, 'rm', '-f', dump], { timeout: 30_000 });
  await host.writeFile(
    `${relative}/README.txt`,
    'Pre-upgrade PostgreSQL dump and Compose configuration. Keep these files private. Restoring requires stopping the upgraded stack and restoring into a clean database with the saved server version. Do not run an old server against a migrated database. Uploaded files remain in the original Docker volumes; this dump does not copy those volumes.\n',
    0o600
  );
  await host.writeFile(
    `${JOURNAL}.tmp`,
    JSON.stringify({ from: deployed.version, to: COMPATIBLE_SWITCH_VERSION, backup: directory }),
    0o600
  );
  await rename(join(host.workingDir, `${JOURNAL}.tmp`), join(host.workingDir, JOURNAL));
}

export async function finishLocalUpgrade(host: ServerHost): Promise<void> {
  await rm(join(host.workingDir, JOURNAL), { force: true });
}
