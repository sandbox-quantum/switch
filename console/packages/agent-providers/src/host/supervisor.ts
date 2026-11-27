import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { isProcessAlive } from '../process-alive';
import type { OwnerVerdict } from './box/owner-records';
import { releaseOwner, replaceOwner, type TicketJudge, withOwnershipLock } from './ownership-lock';
import { fenceDeadOwner, killProcessTree } from './process-fence';
import { pipeRedactedLogs } from './redaction';
import type { SessionLinks } from './session-channel';
import { requestChildStop } from './stop-request';

/**
 * The supervisor records this process holds right now, by path. A record
 * naming this process's own id that is not in here was left by an earlier
 * process with the same id: a container restarting gives the controller the
 * same low id again, so after a crash it finds its own id in the record the
 * old one never released. Box mode reads it (`leftByEarlierSupervisor`).
 */
const heldSupervisors = new Map<string, string>();

/**
 * Whether a supervisor record names this process but was not written by it:
 * left by an earlier process with the same id, so nothing supervises it.
 */
export function leftByEarlierSupervisor(
  path: string,
  record: { pid: number; token?: unknown }
): boolean {
  if (record.pid !== process.pid) return false;
  const held = heldSupervisors.get(resolve(path));
  return held === undefined || held !== record.token;
}

async function ownerRecord(path: string): Promise<{ pid: number; token?: string } | null> {
  try {
    return z
      .object({ pid: z.number().int().positive(), token: z.string().optional() })
      .parse(JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** A supervisor gave up waiting on an earlier worker it could not tell was alive (box mode). */
export class AdoptUnsureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdoptUnsureError';
  }
}

/** How long a box's supervisor waits on an earlier worker it cannot tell is alive. */
export const ADOPT_UNSURE_LIMIT_MS = 60_000;

/**
 * What a box's supervisor does beyond Console's (`box/owner-records`): saved
 * process ids are judged, since a restarted container hands the same low ids
 * out again, and a split box's launcher, not this supervisor, restarts a
 * crashed worker. Given only in box mode.
 */
export type SupervisorBox = {
  judge: (path: string, pid: number) => Promise<OwnerVerdict>;
  ticketJudge: TicketJudge;
  /**
   * Whether a worker that died on a signal is started again here. Split boxes,
   * with a launcher, pass false: only the controller starts a host, with a
   * fresh ticket, so a crash ends this supervisor and the launcher reports it.
   */
  selfRestart: boolean;
  /** This launch's push key: each worker gets it on a pipe of its own (fd 3), written at once and closed. */
  pushKey?: Buffer;
  /** Overrides `ADOPT_UNSURE_LIMIT_MS` (tests). */
  unsureLimitMs?: number;
};

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
 * A Windows process that died of an exception — an access violation, a stack
 * overflow, a fatal error — exits with its NTSTATUS code, 0xC0000000 and up:
 * what a signal is elsewhere, so it is recovered rather than taken as the
 * host refusing to run.
 */
function crashedOnWindows(code: number): boolean {
  return process.platform === 'win32' && code >>> 0 >= 0xc0000000;
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
  /** Box mode only; absent, the supervisor behaves as on Console's own hosts. */
  box?: SupervisorBox;
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
   * process does, and the host is then started without one. The service
   * tokens `links` answers to its hosts are scrubbed from what they write to
   * worker.log.
   */
  links: SessionLinks | null;
}): Promise<void> {
  const box = input.box;
  if (box?.pushKey && input.links)
    throw new Error('A push key goes to a worker with no IPC channel of its own.');
  const directory = join(input.root, 'supervisor');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const ownerPath = join(directory, 'owner.json');
  const owner = { pid: process.pid, token: randomUUID(), build: input.build };
  await withOwnershipLock(
    directory,
    async () => {
      if (!box) {
        const pid = await ownerPid(ownerPath);
        if (pid !== null && isProcessAlive(pid, 'recorded'))
          throw new Error('The shared host supervisor is already running.');
      } else {
        const record = await ownerRecord(ownerPath);
        if (
          record !== null &&
          !leftByEarlierSupervisor(ownerPath, record) &&
          isProcessAlive(record.pid, 'recorded')
        ) {
          const verdict = await box.judge(ownerPath, record.pid);
          if (verdict.kind === 'alive')
            throw new Error('The shared host supervisor is already running.');
          // Not taken over on a guess, and not left silent either: the start fails
          // with the error the agent's room is told about.
          if (verdict.kind === 'unknown')
            throw new AdoptUnsureError(
              `Could not tell whether the supervisor recorded for this session (pid ${record.pid}) is still running; not starting a second one.`
            );
        }
      }
      await replaceOwner(ownerPath, owner);
      heldSupervisors.set(resolve(ownerPath), owner.token);
    },
    box?.ticketJudge
  );
  try {
    let unsureSince: number | null = null;
    while (!input.signal.aborted) {
      // A replacement supervisor adopts a living worker instead of starting a competitor.
      const lockPath = join(input.root, 'shared-owner.lock');
      const existing = await ownerPid(lockPath);
      const living = existing !== null && isProcessAlive(existing, 'recorded');
      // In a box a stale lock (left by an earlier worker, before this box, or
      // naming a thread of another process) has no living worker to adopt.
      const verdict: OwnerVerdict =
        living && box
          ? await box.judge(lockPath, existing)
          : living
            ? { kind: 'alive' }
            : { kind: 'stale', reason: 'gone' };
      if (verdict.kind === 'alive') {
        unsureSince = null;
        await delay(500, undefined, { signal: input.signal });
        continue;
      }
      if (box && verdict.kind === 'unknown') {
        // Neither adopted nor replaced on a guess, but not waited on for ever
        // either: past the limit the start fails, so the agent says it is down.
        const limit = box.unsureLimitMs ?? ADOPT_UNSURE_LIMIT_MS;
        unsureSince ??= Date.now();
        if (Date.now() - unsureSince > limit)
          throw new AdoptUnsureError(
            `Could not tell for ${Math.round(limit / 1000)} s whether the earlier worker (pid ${existing}) is still running; not starting a second one.`
          );
        await delay(500, undefined, { signal: input.signal });
        continue;
      }
      unsureSince = null;
      const log = await open(join(directory, 'worker.log'), 'a', 0o600);
      const spawnedAt = Date.now();
      // A host linked to this process may be handed service tokens at any
      // time, so its output always passes through here.
      const linked = input.links;
      const child = spawn(input.executable, input.args, {
        detached: true,
        windowsHide: true,
        env: input.env,
        stdio: linked
          ? ['ignore', 'pipe', 'pipe', 'ipc']
          : box?.pushKey
            ? ['ignore', log.fd, log.fd, 'pipe']
            : ['ignore', log.fd, log.fd],
      });
      if (box?.pushKey) {
        const keyPipe = child.stdio[3] as NodeJS.WritableStream | null;
        keyPipe?.on('error', () => {});
        keyPipe?.end(box.pushKey);
      }
      input.links?.attach(input.root, child);
      const exited = once(child, 'exit');
      const logged = linked
        ? pipeRedactedLogs([child.stdout!, child.stderr!], log, () =>
            linked.redactions.list()
          ).catch((error: unknown) => {
            child.kill('SIGKILL');
            throw error;
          })
        : log.close();
      logged.catch(() => {});
      // Asked first. A host that has not gone `CHILD_STOP_GRACE_MS` later is
      // waiting on something that will not finish — a session host that hung
      // up and stayed alive, say — and is killed with everything it started,
      // so that stopping this supervisor cannot hang on it.
      let escalation: ReturnType<typeof setTimeout> | null = null;
      const stop = () => {
        requestChildStop(child, input.root).catch((error: unknown) =>
          console.error(`Could not ask the shared host at ${input.root} to stop: ${String(error)}`)
        );
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
        await fenceDeadOwner(child.pid, child.pid, spawnedAt);
        const workerPath = join(input.root, 'shared-owner.lock');
        try {
          const owner = JSON.parse(await readFile(workerPath, 'utf8'));
          if (owner.pid === child.pid) await releaseOwner(input.root, workerPath, owner);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      if (linked)
        try {
          await logged;
        } finally {
          await log.close();
        }
      if (input.signal.aborted) return;
      if (code === 0) return;
      if (code !== null && !crashedOnWindows(code)) {
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
      const how = signal ?? `exception 0x${((code ?? 0) >>> 0).toString(16)}`;
      if (box?.selfRestart === false)
        throw new Error(
          `Shared SDK host exited on ${how}; not restarting it here: the agents controller decides.`
        );
      console.warn(`Shared SDK host exited on ${how}; recovering its saved state.`);
      await delay(1000, undefined, { signal: input.signal });
    }
  } catch (error) {
    if (!input.signal.aborted) throw error;
  } finally {
    await releaseOwner(directory, ownerPath, owner, box?.ticketJudge);
    if (heldSupervisors.get(resolve(ownerPath)) === owner.token)
      heldSupervisors.delete(resolve(ownerPath));
  }
}
