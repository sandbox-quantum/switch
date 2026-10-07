import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { dirMode, fileMode } from './host-permissions';

const ticketSchema = z.strictObject({
  choosing: z.boolean(),
  ticket: z.number().int().nonnegative(),
});
type Ticket = z.infer<typeof ticketSchema>;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

async function save(path: string, value: unknown, replace: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', fileMode());
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if (replace) await rename(temporary, path);
    else await link(temporary, path);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** A live process held its ticket past the wait; `holders` are the processes still ahead. */
export class OwnershipContendedError extends Error {
  readonly holders: number[];

  constructor(holders: number[]) {
    const self = holders.includes(process.pid) ? ', this process among them' : '';
    super(
      `FENCING_REQUIRED: another live host is acquiring ownership (pid ${holders.join(', ')}${self}).`
    );
    this.name = 'OwnershipContendedError';
    this.holders = holders;
  }
}

/** Bakery election: each contender writes only its own ticket, so reclamation needs no lock. */
export async function withOwnershipLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const directory = join(root, 'ownership');
  await mkdir(directory, { recursive: true, mode: dirMode() });
  const id = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, id);
  const entries = async (): Promise<Array<{ id: string; value: Ticket }>> => {
    const result = [];
    for (const name of await readdir(directory)) {
      if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const pid = Number(name.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid ownership ticket PID.');
      if (!alive(pid)) continue;
      try {
        result.push({
          id: name,
          value: ticketSchema.parse(JSON.parse(await readFile(join(directory, name), 'utf8'))),
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  };
  await save(path, { choosing: true, ticket: 0 }, false);
  try {
    const ticket = Math.max(0, ...(await entries()).map((entry) => entry.value.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('Ownership ticket space exhausted.');
    await save(path, { choosing: false, ticket }, true);
    const deadline = performance.now() + 15000;
    for (;;) {
      const ahead = (await entries()).filter(
        (entry) =>
          entry.id !== id &&
          (entry.value.choosing ||
            entry.value.ticket < ticket ||
            (entry.value.ticket === ticket && entry.id < id))
      );
      if (!ahead.length) break;
      if (performance.now() >= deadline)
        throw new OwnershipContendedError([
          ...new Set(ahead.map((entry) => Number(entry.id.split('-')[0]))),
        ]);
      await delay(25);
    }
    return await action();
  } finally {
    await unlink(path);
  }
}

/** How long {@link withOwnershipLockOutlasting} waits for the processes ahead of it to finish or exit. */
export const OUTLAST_PATIENCE_MS = 120_000;

/**
 * {@link withOwnershipLock} for a start that may overlap the exit of the
 * process it replaces, such as a Console restarting: the old process can
 * hold its ticket for as long as it takes to shut down, longer than the lock
 * waits. Contention is retried until the processes ahead finish or exit, up
 * to {@link OUTLAST_PATIENCE_MS}. Null when `signal` aborts while waiting.
 */
export async function withOwnershipLockOutlasting<T>(
  root: string,
  action: () => Promise<T>,
  signal: AbortSignal
): Promise<{ value: T } | null> {
  const deadline = performance.now() + OUTLAST_PATIENCE_MS;
  let warned = false;
  for (;;) {
    try {
      return { value: await withOwnershipLock(root, action) };
    } catch (error) {
      if (!(error instanceof OwnershipContendedError) || performance.now() >= deadline) throw error;
      if (!warned) {
        console.warn(
          `${error.message} Waiting up to ${OUTLAST_PATIENCE_MS / 1000} s for it to finish or exit, as a process shutting down does.`
        );
        warned = true;
      }
    }
    await delay(1000, undefined, { signal }).catch(() => {});
    if (signal.aborted) return null;
  }
}

export async function replaceOwner(path: string, value: unknown): Promise<void> {
  await save(path, value, true);
}

export async function releaseOwner(root: string, path: string, owner: unknown): Promise<void> {
  await withOwnershipLock(root, async () => {
    try {
      const current = JSON.parse(await readFile(path, 'utf8'));
      if (JSON.stringify(current) === JSON.stringify(owner)) await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  });
}
