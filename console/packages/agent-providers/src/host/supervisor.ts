import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { LEASE_EXPIRED_EXIT_CODE } from './exit-codes';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import { fenceDeadOwner, killProcessTree } from './process-fence';
import type { SessionLinks } from './session-channel';

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

/**
 * How long a supervised host asked to stop is given before it and what it
 * started are killed. Shorter than the launcher's `STOP_GRACE_MS`, so a chain
 * — a watcher's supervisor, the watcher, its session hosts — comes down inside
 * the time a replacement waits for it.
 */
export const CHILD_STOP_GRACE_MS = 10_000;
export async function superviseSharedHost(input: {
  root: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** The bundle this supervisor respawns, recorded so a later deployment can
   * tell its own host apart from one an earlier build left running. */
  build: string;
  /**
   * Handed each host as it is spawned, with an IPC channel open to it, for a
   * parent that talks to its sessions directly. Null where nothing in this
   * process does, and the host is then started without one.
   */
  links: SessionLinks | null;
}): Promise<void> {
  const directory = join(input.root, 'supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerPath = join(directory, 'owner.json');
  const owner = { pid: process.pid, token: randomUUID(), build: input.build };
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
        stdio: input.links ? ['ignore', log.fd, log.fd, 'ipc'] : ['ignore', log.fd, log.fd],
      });
      input.links?.attach(input.root, child);
      const exited = once(child, 'exit');
      await log.close();
      // Asked first. A host that has not gone `CHILD_STOP_GRACE_MS` later is
      // waiting on something that will not finish — a session host that hung
      // up and stayed alive, say — and is killed with everything it started,
      // so that stopping this supervisor cannot hang on it.
      let escalation: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        child.kill('SIGTERM');
        escalation ??= setTimeout(() => {
          if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
          console.warn(
            `The shared host at ${input.root} did not stop within ${CHILD_STOP_GRACE_MS / 1000} s of being asked; killing it and everything it started.`
          );
          killProcessTree(child.pid).catch((error: unknown) =>
            console.error(`Could not kill the shared host at ${input.root}: ${String(error)}`)
          );
        }, CHILD_STOP_GRACE_MS);
        escalation.unref?.();
      };
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
      let code: number | null;
      let signal: NodeJS.Signals | null;
      try {
        [code, signal] = await exited;
      } finally {
        input.signal.removeEventListener('abort', stop);
        if (escalation) clearTimeout(escalation);
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
