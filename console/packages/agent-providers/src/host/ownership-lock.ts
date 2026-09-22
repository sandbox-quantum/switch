import { randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
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

async function save(path: string, value: unknown, replace: boolean): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
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
    while (
      (await entries()).some(
        (entry) =>
          entry.id !== id &&
          (entry.value.choosing ||
            entry.value.ticket < ticket ||
            (entry.value.ticket === ticket && entry.id < id))
      )
    ) {
      if (performance.now() >= deadline)
        throw new Error('FENCING_REQUIRED: another live host is acquiring ownership.');
      await delay(25);
    }
    return await action();
  } finally {
    await unlink(path);
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
