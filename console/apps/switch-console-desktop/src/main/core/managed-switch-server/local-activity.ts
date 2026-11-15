import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log } from '@main/lib/logger';
import type {
  LocalActivityAction,
  LocalActivityEntry,
} from '@shared/core/managed-switch-server/managed-switch-server';
import { localServerDir } from './paths';

/** Enough to cover the server page's recent activity and "last running". */
const KEPT = 50;

const ACTIONS: ReadonlySet<string> = new Set<LocalActivityAction>([
  'started',
  'stopped',
  'start-failed',
  'updated',
  'reset',
  'crashed',
]);

function activityFile(): string {
  return join(localServerDir(), 'activity.json');
}

function isEntry(value: unknown): value is LocalActivityEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.at === 'string' &&
    typeof v.action === 'string' &&
    ACTIONS.has(v.action) &&
    (v.detail === null || typeof v.detail === 'string')
  );
}

/**
 * The local stack's history, most recent first. Empty before anything has been
 * recorded; throws when the file is there but cannot be read, so the page says
 * so instead of showing a history that looks merely short.
 */
export async function readLocalActivity(): Promise<LocalActivityEntry[]> {
  let text: string;
  try {
    text = await readFile(activityFile(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error('The local server history is not a list.');
  return parsed.filter(isEntry);
}

/**
 * Add an entry to the history. A record, not part of the operation it
 * describes: failing to write it is logged and the operation stands.
 */
export async function recordLocalActivity(
  action: LocalActivityAction,
  detail: string | null
): Promise<void> {
  try {
    let previous: LocalActivityEntry[] = [];
    try {
      previous = await readLocalActivity();
    } catch (error) {
      log.warn('local-switch-server: starting a new history over an unreadable one', { error });
    }
    const entry: LocalActivityEntry = { at: new Date().toISOString(), action, detail };
    const next = [entry, ...previous].slice(0, KEPT);
    await mkdir(localServerDir(), { recursive: true });
    const tmp = `${activityFile()}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
    await rename(tmp, activityFile());
  } catch (error) {
    log.warn(`local-switch-server: could not record "${action}" in the history`, { error });
  }
}
