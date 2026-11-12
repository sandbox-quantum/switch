import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

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
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/**
 * Whether the ticket at `path` was written before the process now holding
 * `pid` started: left by an earlier process with that id (after a restart),
 * so it is no contender. `process-fence`'s `recordPredatesHolder`, written out
 * for the same reason as `recordMode`. Never true on Windows, whose ids are
 * not checked here.
 */
async function ticketPredatesHolder(path: string, pid: number): Promise<boolean> {
  if (process.platform === 'win32') return false;
  // A ticket in an election under way is seconds old, and one left by an
  // earlier process is older: only those are worth a look, so a busy election
  // does not run `ps` for every rival on every pass.
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (Date.now() - mtimeMs < 5_000) return false;
  // Written before this box (or machine) started: nothing in it can be alive.
  // `process-fence`'s box-start check, written out: boot time plus pid 1's
  // start ticks, from /proc, with no `ps`.
  if (process.platform === 'linux') {
    try {
      const boot = /^btime\s+(\d+)/m.exec(readFileSync('/proc/stat', 'utf8'));
      const pidOne = readFileSync('/proc/1/stat', 'utf8');
      const ticks = Number(pidOne.slice(pidOne.lastIndexOf(')') + 2).split(' ')[19]);
      if (
        boot &&
        Number.isFinite(ticks) &&
        mtimeMs < (Number(boot[1]) + ticks / 100) * 1000 - 2_000
      )
        return true;
    } catch {
      // Unreadable: fall through to the per-id checks.
    }
  }
  // On Linux a thread's id answers kill(id, 0) too; a thread of some other
  // process is no contender (`process-fence`'s `processExists`, written out).
  if (process.platform === 'linux') {
    try {
      const tgid = /^Tgid:\s*(\d+)/m.exec(readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1];
      if (tgid !== undefined && Number(tgid) !== pid) return true;
    } catch (error) {
      // Only "no such process" makes it stale. Any other read error counts the
      // rival, or an election could end with two winners.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      return false;
    }
  }
  const etime = await new Promise<string | null>((resolve) =>
    execFile('ps', ['-p', String(pid), '-o', 'etime='], { encoding: 'utf8' }, (error, stdout) =>
      resolve(error ? null : stdout.trim())
    )
  );
  const match = etime === null ? null : /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(etime);
  if (!match) return false;
  const [, days = '0', hours = '0', minutes, seconds] = match;
  const elapsed =
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes!)) * 60 + Number(seconds!)) * 1000;
  return mtimeMs < Date.now() - elapsed - 2_000;
}

/**
 * `recordMode()` from `host-permissions`, written out: this module takes
 * no relative import, since its tests load it on its own in a child process.
 */
function recordMode(): number {
  return process.env.SWITCH_HOST_SHARED_GROUP === '1' ? 0o640 : 0o600;
}

/**
 * `replaceFile` from `replace-file`, for any operation: on Windows a rename
 * or link onto a record another contender has open is refused while it stays
 * open, and so is opening a record another contender is replacing or
 * deleting, so it is tried again for a few seconds.
 */
async function waitingOutSharing<T>(operation: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 5_000;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try {
      return await operation();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(code)) throw error;
      if (Date.now() > deadline) throw error;
    }
    await delay(wait);
  }
}

async function save(path: string, value: unknown, replace: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', recordMode());
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await waitingOutSharing(() => (replace ? rename(temporary, path) : link(temporary, path)));
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

/**
 * The tickets this process holds right now. A ticket named for this process's
 * own id that is not in here was left by an earlier process with the same id
 * (a restarted container gives the controller the same low id), killed in the
 * middle of an election.
 */
const ownTickets = new Set<string>();

/** Bakery election: each contender writes only its own ticket, so reclamation needs no lock. */
export async function withOwnershipLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const directory = join(root, 'ownership');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, id);
  const entries = async (): Promise<Array<{ id: string; value: Ticket }>> => {
    const result = [];
    for (const name of await readdir(directory)) {
      if (!/^\d+-[a-f0-9-]+\.json$/.test(name)) continue;
      const pid = Number(name.split('-')[0]);
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid ownership ticket PID.');
      if (
        pid === process.pid
          ? !ownTickets.has(join(directory, name))
          : !alive(pid) || (await ticketPredatesHolder(join(directory, name), pid))
      )
        continue;
      try {
        const text = await waitingOutSharing(() => readFile(join(directory, name), 'utf8'));
        result.push({ id: name, value: ticketSchema.parse(JSON.parse(text)) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return result;
  };
  ownTickets.add(path);
  try {
    await save(path, { choosing: true, ticket: 0 }, false);
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
    ownTickets.delete(path);
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
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
