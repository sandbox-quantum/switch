import { randomUUID } from 'node:crypto';
import { join, posix } from 'node:path';
import { z } from 'zod';
import { log } from '@main/lib/logger';
import { compareVersions } from '@main/lib/semver';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  CHECKOUT_IMAGE_TAG,
  type ManagedServerUpgrade,
  type SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { composeUpService, runDocker, serviceContainerId } from './compose';
import { COMPOSE_FILE_NAME, ENV_FILE_NAME } from './constants';
import { classifyVersionDrift, readDeployedVersion } from './deployed-version';
import type { ServerHost } from './host/types';

/**
 * Moving a managed stack forward onto this build's switch-core pin.
 *
 * switch-core migrates its database on boot and has no way back, so before a
 * start rewrites the stack at a newer pin the database is dumped next to the
 * stack, on whichever host runs it. A journal records that an upgrade is under
 * way: it is written once the backup is complete and removed once the stack is
 * healthy at the pin, so an upgrade interrupted anywhere in between is resumed
 * on the next start (without a second backup, which would capture a
 * half-migrated database) or refused loudly when this app cannot finish it.
 */

/** Journal of an upgrade in progress, in the host working dir. */
export const UPGRADE_JOURNAL_FILE = 'upgrade.json';
const BACKUPS_DIR = 'backups';
const DATABASE_SERVICE = 'postgres';
/** A dump of a large install over a slow disk can take a while. */
const DUMP_TIMEOUT_MS = 30 * 60 * 1000;

const journalSchema = z.object({ from: z.string(), to: z.string(), backup: z.string() });
export type UpgradeJournal = z.infer<typeof journalSchema>;

/** `from` → `to` of an upgrade a stack still owes this build. */
export type OwedUpgrade = { from: string; to: string };

function hostPath(host: ServerHost, relPath: string): string {
  return host.kind === 'local'
    ? join(host.workingDir, relPath)
    : posix.join(host.workingDir, relPath);
}

/**
 * The journal of an interrupted upgrade on `host`, or null when none is under
 * way. A journal that cannot be read throws: it means an upgrade was
 * interrupted and there is no telling how far it got.
 */
export async function readUpgradeJournal(host: ServerHost): Promise<UpgradeJournal | null> {
  const raw = await host.readFile(UPGRADE_JOURNAL_FILE);
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const journal = journalSchema.safeParse(parsed);
  if (!journal.success) {
    throw new Error(
      `An earlier switch-core update on ${host.label} was interrupted and its journal ` +
        `(${hostPath(host, UPGRADE_JOURNAL_FILE)}) cannot be read. Its database backup is under ` +
        `${hostPath(host, BACKUPS_DIR)}. Check the stack, then delete the journal to update again.`
    );
  }
  return journal.data;
}

/**
 * The upgrade a stack owes this build: the interrupted one its journal names,
 * or the one its deployed version being behind the pin calls for. Null when it
 * is in step, ahead, or not comparable — those keep their own handling.
 */
export function owedUpgrade(
  drift: SwitchVersionDrift | null,
  journal: UpgradeJournal | null
): OwedUpgrade | null {
  if (journal) return { from: journal.from, to: COMPATIBLE_SWITCH_VERSION };
  if (drift?.direction === 'upgrade') return { from: drift.deployed, to: drift.expected };
  return null;
}

/** The status of an owed upgrade: running now, or waiting for the next start. */
export function upgradeState(owed: OwedUpgrade, running: boolean): ManagedServerUpgrade {
  return { state: running ? 'updating' : 'pending', from: owed.from, to: owed.to };
}

/**
 * Get `host` ready to be rewritten at this build's pin: resume an interrupted
 * upgrade, or back the database up and journal a new one. Returns the journal,
 * or null when the start is not an upgrade (first install, same version, a
 * checkout build, or a version that is unreadable or not comparable — the
 * start pipeline guards those separately).
 *
 * `onUpgrade` fires before any work, so the caller can show the update and hold
 * sessions for the whole of it. Any failure throws, leaving the stack's
 * configuration untouched.
 */
export async function prepareUpgrade(
  host: ServerHost,
  checkoutRoot: string | null,
  onMessage: (message: string) => void,
  onUpgrade: (upgrade: OwedUpgrade) => void
): Promise<UpgradeJournal | null> {
  const pending = await readUpgradeJournal(host);
  if (pending) {
    const order = compareVersions(pending.to, COMPATIBLE_SWITCH_VERSION);
    if (order === null || order > 0) {
      throw new Error(
        `An interrupted update on ${host.label} was moving switch-core to ${pending.to}, which ` +
          `this app (switch-core ${COMPATIBLE_SWITCH_VERSION}) cannot finish. Install a Switch ` +
          `Console with switch-core ${pending.to} or newer. The database backup taken before ` +
          `that update is in ${pending.backup}.`
      );
    }
    onUpgrade({ from: pending.from, to: COMPATIBLE_SWITCH_VERSION });
    log.warn(
      `managed-switch-server: resuming the interrupted switch-core update on ${host.label} ` +
        `(${pending.from} → ${COMPATIBLE_SWITCH_VERSION}); backup in ${pending.backup}`
    );
    if (pending.to === COMPATIBLE_SWITCH_VERSION) return pending;
    const resumed = { ...pending, to: COMPATIBLE_SWITCH_VERSION };
    await writeJournal(host, resumed);
    return resumed;
  }
  if (checkoutRoot !== null) return null;
  const deployed = await readDeployedVersion(host);
  if (deployed.kind !== 'deployed' || deployed.version === CHECKOUT_IMAGE_TAG) return null;
  if (classifyVersionDrift(deployed.version, COMPATIBLE_SWITCH_VERSION)?.direction !== 'upgrade') {
    return null;
  }
  onUpgrade({ from: deployed.version, to: COMPATIBLE_SWITCH_VERSION });
  const backup = await backupDatabase(host, deployed.version, onMessage);
  const journal = { from: deployed.version, to: COMPATIBLE_SWITCH_VERSION, backup };
  await writeJournal(host, journal);
  return journal;
}

/** Record that the upgrade finished: the stack is healthy at the pin. */
export async function finishUpgrade(host: ServerHost): Promise<void> {
  await host.removeFile(UPGRADE_JOURNAL_FILE);
}

async function writeJournal(host: ServerHost, journal: UpgradeJournal): Promise<void> {
  await host.writeFile(UPGRADE_JOURNAL_FILE, `${JSON.stringify(journal, null, 2)}\n`, 0o600);
}

/**
 * Dump every database of the stack as it is deployed now, plus the compose
 * file and `.env` that describe it, into a new timestamped directory under
 * `backups/` in the host working dir. Returns that directory's path on the
 * host.
 *
 * The dump is written inside the database container and copied out with
 * `docker cp`, so nothing is buffered through Console or piped through a shell
 * that may not exist on the host; the same commands work locally and over SSH.
 */
async function backupDatabase(
  host: ServerHost,
  from: string,
  onMessage: (message: string) => void
): Promise<string> {
  onMessage(
    `Backing up the database before updating switch-core ${from} → ${COMPATIBLE_SWITCH_VERSION}…`
  );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const directory = `${BACKUPS_DIR}/${stamp}-switch-core-${from}`;
  await host.writeFile(`${directory}/README.txt`, backupReadme(from), 0o600);
  await host.restrictMode(directory, 0o700);
  for (const file of [COMPOSE_FILE_NAME, ENV_FILE_NAME]) {
    const content = await host.readFile(file);
    if (content === null) {
      throw new Error(
        `Cannot back up the Switch server on ${host.label} before updating it: ${file} is missing from ${host.workingDir}.`
      );
    }
    await host.writeFile(`${directory}/${file}`, content, 0o600);
  }

  await composeUpService(host, DATABASE_SERVICE);
  const container = await serviceContainerId(host, DATABASE_SERVICE);
  const inContainer = `/tmp/switch-upgrade-${randomUUID()}.sql`;
  const destination = `${directory}/database.sql`;
  try {
    await runDocker(
      host,
      [
        'exec',
        container,
        'sh',
        '-c',
        'umask 077 && pg_dumpall -U "$POSTGRES_USER" -f "$1" && test -s "$1"',
        'sh',
        inContainer,
      ],
      DUMP_TIMEOUT_MS
    );
    await runDocker(host, ['cp', `${container}:${inContainer}`, destination], DUMP_TIMEOUT_MS);
  } finally {
    await runDocker(host, ['exec', container, 'rm', '-f', inContainer], 60_000).catch(
      (error: unknown) => {
        log.warn(
          `managed-switch-server: could not remove the temporary dump ${inContainer} from the database container on ${host.label}`,
          { error: String(error) }
        );
      }
    );
  }
  await host.restrictMode(destination, 0o600);
  const path = hostPath(host, directory);
  log.info(`managed-switch-server: backed up ${host.label} to ${path} before updating`);
  return path;
}

function backupReadme(from: string): string {
  return [
    `Switch Console took this backup before updating the Switch server from switch-core ${from} to ${COMPATIBLE_SWITCH_VERSION}.`,
    '',
    'database.sql                   pg_dumpall of every database in the stack',
    `${COMPOSE_FILE_NAME}  the compose file the stack ran with`,
    `${ENV_FILE_NAME}                           its environment, including credentials`,
    '',
    'Keep these files private. switch-core migrates its database forward and cannot run',
    `against it at ${from} again once the update has started. To go back, stop the stack and`,
    `restore database.sql into a fresh database volume with switch-core ${from}.`,
    'Uploaded files stay in the Docker volumes; this dump does not copy them.',
    '',
  ].join('\n');
}
