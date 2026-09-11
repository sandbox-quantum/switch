import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function ownProcessGroup(): Promise<number | null> {
  if (process.platform === 'win32') return null;
  const { stdout } = await execute('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
  return Number(stdout.trim()) === process.pid ? process.pid : null;
}

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

/** Only a dead group leader can be reclaimed; a live owner is never displaced. */
export async function fenceDeadOwner(pid: number, group: number | null): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid shared host owner PID.');
  if (exists(pid)) throw new Error('FENCING_REQUIRED: the shared host owner is still alive.');
  if (group !== pid || process.platform === 'win32')
    throw new Error('FENCING_REQUIRED: the previous host did not isolate its provider processes.');
  if (!exists(-group)) return;
  try {
    process.kill(-group, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
    throw error;
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if (!exists(-group)) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    }
    await delay(50);
  }
  throw new Error('FENCING_REQUIRED: the previous provider process group has not exited.');
}
