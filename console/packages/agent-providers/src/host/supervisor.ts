import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { GROUPED_CHILDREN, stopProcessTree } from '../process-tree';
import { LEASE_EXPIRED_EXIT_CODE, STOP_INCOMPLETE_EXIT_CODE } from './exit-codes';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { fenceDeadOwner } from './process-fence';

/**
 * How long a worker has to stop on its own before the supervisor fences it.
 *
 * Asking a resident host to stop is not the same as it stopping: a provider
 * child that will not drain, or a socket nobody closed, keeps the process alive
 * with nothing left running in it. Waiting on that for ever is how a supervisor
 * that exists to bound failures becomes one.
 */
const STOP_GRACE_MS = 30000;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function ownerPid(path: string): Promise<number | null> {
  try {
    const owner = z
      .object({ pid: z.number().int().positive() })
      .parse(JSON.parse(await readFile(path, 'utf8')));
    return owner.pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function superviseSharedHost(input: {
  root: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
}): Promise<void> {
  const directory = join(input.root, 'supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerPath = join(directory, 'owner.json');
  const owner = { pid: process.pid, token: randomUUID() };
  await withOwnershipLock(directory, async () => {
    const pid = await ownerPid(ownerPath);
    if (pid !== null && alive(pid))
      throw new Error('The shared host supervisor is already running.');
    await replaceOwner(ownerPath, owner);
  });
  try {
    while (!input.signal.aborted) {
      // A replacement supervisor adopts a living worker instead of starting a competitor.
      const existing = await ownerPid(join(input.root, 'shared-owner.lock'));
      if (existing !== null && alive(existing)) {
        await delay(500, undefined, { signal: input.signal });
        continue;
      }
      const log = await open(join(directory, 'worker.log'), 'a', 0o600);
      const child = spawn(input.executable, input.args, {
        detached: true,
        env: input.env,
        stdio: ['ignore', log.fd, log.fd],
      });
      const exited = once(child, 'exit');
      await log.close();
      let escalation: Promise<void> | null = null;
      const stop = () => {
        child.kill('SIGTERM');
        escalation ??= (async () => {
          await delay(STOP_GRACE_MS);
          if (child.exitCode !== null || child.signalCode !== null) return;
          console.warn(
            `The SDK host has not exited ${STOP_GRACE_MS}ms after being asked to stop; fencing its process group.`
          );
          await stopProcessTree(child, {
            grouped: GROUPED_CHILDREN,
            escalateAfterMs: 0,
            deadlineMs: 10000,
            description: 'SDK host process group',
          });
        })().catch((error: unknown) => {
          console.error('The SDK host could not be fenced after a stop request:', String(error));
        });
      };
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
      let code: number | null;
      let signal: NodeJS.Signals | null;
      try {
        [code, signal] = await exited;
      } finally {
        input.signal.removeEventListener('abort', stop);
        await escalation;
      }
      if (child.pid) {
        await fenceDeadOwner(child.pid, child.pid);
        const workerPath = join(input.root, 'shared-owner.lock');
        try {
          const owner = JSON.parse(await readFile(workerPath, 'utf8'));
          if (owner.pid === child.pid) await releaseOwner(input.root, workerPath, owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (input.signal.aborted) return;
      if (code === 0) return;
      if (code === STOP_INCOMPLETE_EXIT_CODE) {
        // The host stopped but left sessions behind and said so. Its group has
        // just been fenced above, which is the escalation it was asking for.
        console.warn(
          'The SDK host stopped with room sessions still draining; its process group was fenced.'
        );
        return;
      }
      if (code === LEASE_EXPIRED_EXIT_CODE) {
        console.warn('Shared SDK host lease expired; relaunching from saved state after fencing.');
        await delay(1000, undefined, { signal: input.signal });
        continue;
      }
      if (code !== null) {
        try {
          await readFile(join(directory, 'failure.json'));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await replaceOwner(join(directory, 'failure.json'), {
            message: `Shared SDK host exited with code ${code}. Inspect worker.log before reopening.`,
          });
        }
        throw new Error(`Shared SDK host failed with exit code ${code}.`);
      }
      console.warn(`Shared SDK host exited on ${signal}; recovering its saved state.`);
      await delay(1000, undefined, { signal: input.signal });
    }
  } catch (error) {
    if (!input.signal.aborted) throw error;
  } finally {
    await releaseOwner(directory, ownerPath, owner);
  }
}
