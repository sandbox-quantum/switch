import { execFileSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/** The owner records a host writes under its state root, in stop order. */
export const OWNER_RECORDS = ['shared-owner.lock', 'supervisor/owner.json'] as const;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function ownerPid(path: string): Promise<number | null> {
  try {
    const { pid } = JSON.parse(await readFile(path, 'utf8'));
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * A saved PID only counts while it still names the host that wrote it. After a
 * hard shutdown the number can belong to something else entirely, and acting on
 * that would mean waiting on — or refusing to replace — an unrelated process.
 */
export function ownsRoot(pid: number, root: string): boolean {
  try {
    return execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8',
    }).includes(root);
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

/** True while a process other than this one still owns the root. */
export async function ownedElsewhere(root: string): Promise<boolean> {
  for (const record of OWNER_RECORDS) {
    const pid = await ownerPid(join(root, record));
    if (pid !== null && pid !== process.pid && alive(pid) && ownsRoot(pid, root)) return true;
  }
  return false;
}

/**
 * Drops owner records left by a process that is gone. Console's own watcher
 * never writes a supervisor record, so one surviving here is always residue —
 * and the launch path treats a live PID in it as "already running", which would
 * keep the replacement watcher from ever starting.
 */
export async function clearStaleOwners(root: string): Promise<void> {
  for (const record of OWNER_RECORDS) {
    const path = join(root, record);
    const pid = await ownerPid(path);
    if (pid === null || (pid !== process.pid && alive(pid) && ownsRoot(pid, root))) continue;
    if (pid === process.pid) continue;
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
