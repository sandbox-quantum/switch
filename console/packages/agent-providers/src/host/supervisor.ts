import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { LEASE_EXPIRED_EXIT_CODE } from './exit-codes';
import { pipeRedactedHostedLogs } from './hosted-log';
import { releaseOwner, replaceOwner, withOwnershipLock } from './ownership-lock';
import type { fenceDeadOwner } from './process-fence';

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

async function waitForExit(
  exited: Promise<unknown[]>,
  timeoutMs: number
): Promise<[number | null, NodeJS.Signals | null]> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('FENCING_REQUIRED: the shared SDK host did not exit after SIGKILL.')),
      timeoutMs
    );
    timeout.unref();
    void exited.then(
      (result) => {
        clearTimeout(timeout);
        resolve(result as [number | null, NodeJS.Signals | null]);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}

export async function superviseSharedHost(input: {
  root: string;
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** The bundle this supervisor respawns, recorded so a later deployment can
   * tell its own host apart from one an earlier build left running. */
  build: string;
  existingWorker: 'adopt' | 'reject';
  fenceDeadWorker: typeof fenceDeadOwner;
  logRedactions: string[];
  shutdownTimeoutMs: number | null;
  clearFailureOnStart: boolean;
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
    let failureCleared = false;
    while (!input.signal.aborted) {
      // A replacement supervisor adopts a living worker instead of starting a competitor.
      const existing = await ownerPid(join(input.root, 'shared-owner.lock'));
      if (existing !== null && alive(existing)) {
        if (input.existingWorker === 'reject')
          throw new Error(
            'The hosted SDK worker is already running without this supervisor; refusing to adopt it.'
          );
        await delay(500, undefined, { signal: input.signal });
        continue;
      }
      const log = await open(join(directory, 'worker.log'), 'a', 0o600);
      try {
        if (input.clearFailureOnStart && !failureCleared) {
          await unlink(join(directory, 'failure.json')).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
          failureCleared = true;
        }
      } catch (error) {
        await log.close();
        throw error;
      }
      const redactLogs = input.logRedactions.length > 0;
      const child = spawn(input.executable, input.args, {
        detached: true,
        env: input.env,
        stdio: redactLogs ? ['ignore', 'pipe', 'pipe'] : ['ignore', log.fd, log.fd],
      });
      const exited = once(child, 'exit');
      const logsFinished: Promise<Error | null> = redactLogs
        ? pipeRedactedHostedLogs([child.stdout!, child.stderr!], log, input.logRedactions)
            .then(() => null)
            .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))
        : Promise.resolve(null);
      const logFailed = logsFinished.then((error) =>
        error
          ? Promise.reject(error)
          : new Promise<never>(() => {
              /* A successful log stream cannot win the worker-exit race. */
            })
      );
      if (!redactLogs) await log.close();
      let gracefulTimer: ReturnType<typeof setTimeout> | undefined;
      let forcedTimer: ReturnType<typeof setTimeout> | undefined;
      let rejectForcedStop!: (error: Error) => void;
      const forcedStopFailed = new Promise<never>((_resolve, reject) => {
        rejectForcedStop = reject;
      });
      const stop = () => {
        child.kill('SIGTERM');
        if (input.shutdownTimeoutMs === null) return;
        gracefulTimer = setTimeout(() => {
          console.warn('Shared SDK host did not stop after SIGTERM; sending SIGKILL.');
          child.kill('SIGKILL');
          forcedTimer = setTimeout(
            () =>
              rejectForcedStop(
                new Error('FENCING_REQUIRED: the shared SDK host did not exit after SIGKILL.')
              ),
            5000
          );
          forcedTimer.unref();
        }, input.shutdownTimeoutMs);
        gracefulTimer.unref();
      };
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
      let code: number | null;
      let signal: NodeJS.Signals | null;
      let outputError: Error | null = null;
      try {
        [code, signal] = await Promise.race([exited, forcedStopFailed, logFailed]);
      } catch (error) {
        outputError = error instanceof Error ? error : new Error(String(error));
        child.kill('SIGKILL');
        try {
          [code, signal] = await waitForExit(exited, 5000);
        } catch (terminationError) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          await logsFinished;
          if (redactLogs) await log.close().catch(() => {});
          throw terminationError;
        }
      } finally {
        if (gracefulTimer) clearTimeout(gracefulTimer);
        if (forcedTimer) clearTimeout(forcedTimer);
        input.signal.removeEventListener('abort', stop);
      }
      if (child.pid) {
        try {
          await input.fenceDeadWorker(child.pid, child.pid);
          const workerPath = join(input.root, 'shared-owner.lock');
          try {
            const owner = JSON.parse(await readFile(workerPath, 'utf8'));
            if (owner.pid === child.pid) await releaseOwner(input.root, workerPath, owner);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        } catch (error) {
          child.stdout?.destroy();
          child.stderr?.destroy();
          await logsFinished;
          if (redactLogs) await log.close().catch(() => {});
          throw error;
        }
      }
      const completedLogError = await logsFinished;
      if (redactLogs) await log.close();
      if (outputError) throw outputError;
      if (completedLogError) throw completedLogError;
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
    if (!input.signal.aborted || (error as Error).name !== 'AbortError') throw error;
  } finally {
    await releaseOwner(directory, ownerPath, owner);
  }
}
