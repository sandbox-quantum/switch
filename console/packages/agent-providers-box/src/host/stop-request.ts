import type { ChildProcess } from 'node:child_process';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Asking a process to stop and letting it finish what it was doing.
 *
 * On macOS and Linux that is SIGTERM. Windows has no signal one process can
 * send another and have it caught: `kill('SIGTERM')` there ends the process
 * on the spot, mid-write. So on Windows a child with an IPC channel is sent
 * `STOP_MESSAGE`, and a process known only by its id is asked through a file
 * in the state root it runs for, `stopFile(root, pid)`, which it watches.
 */
export const STOP_MESSAGE = { kind: 'switch-stop' } as const;

export function isStopMessage(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { kind?: unknown }).kind === STOP_MESSAGE.kind
  );
}

/** Where the process `pid`, running for the state root `root`, is asked to stop on Windows. */
export function stopFile(root: string, pid: number): string {
  return join(root, `.stop-${pid}`);
}

const STOP_FILE_POLL_MS = 250;

/**
 * Ask `child`, running for the state root `root`, to stop: SIGTERM, or on
 * Windows `STOP_MESSAGE` over its IPC channel, or its stop file without one.
 */
export async function requestChildStop(
  child: Pick<ChildProcess, 'connected' | 'send' | 'kill' | 'pid'>,
  root: string
): Promise<void> {
  if (process.platform !== 'win32') {
    child.kill('SIGTERM');
    return;
  }
  if (child.connected) {
    child.send(STOP_MESSAGE);
    return;
  }
  if (child.pid) await requestStop(root, child.pid);
}

/** Ask the process `pid`, running for `root`, to stop: SIGTERM, or its stop file on Windows. */
export async function requestStop(root: string, pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    process.kill(pid, 'SIGTERM');
    return;
  }
  await writeFile(stopFile(root, pid), JSON.stringify({ pid, at: Date.now() }), { mode: 0o600 });
}

/**
 * Calls `stop` once when this process is asked to stop: SIGTERM or SIGINT,
 * `STOP_MESSAGE` from its parent, or — on Windows, with a `root` — its stop
 * file appearing there. Returns what removes the listeners.
 */
export function onStopRequest(stop: () => void, root: string | null): () => void {
  let stopped = false;
  const once = () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
  const onMessage = (raw: unknown) => {
    if (isStopMessage(raw)) once();
  };
  process.on('SIGTERM', once);
  process.on('SIGINT', once);
  process.on('message', onMessage);
  let timer: ReturnType<typeof setInterval> | null = null;
  if (process.platform === 'win32' && root !== null) {
    const path = stopFile(root, process.pid);
    const started = performance.timeOrigin;
    let checking = false;
    timer = setInterval(() => {
      if (checking) return;
      checking = true;
      readFile(path, 'utf8')
        .then(async (text) => {
          const request = JSON.parse(text) as { pid?: unknown; at?: unknown };
          await unlink(path).catch(ignoreMissing);
          // One left for an earlier process that had this id is not for this one.
          if (request.pid !== process.pid || typeof request.at !== 'number' || request.at < started)
            return;
          once();
        }, ignoreMissing)
        .catch((error: unknown) => console.warn(`Could not read ${path}: ${String(error)}`))
        .finally(() => {
          checking = false;
        });
    }, STOP_FILE_POLL_MS);
    timer.unref();
  }
  return () => {
    process.off('SIGTERM', once);
    process.off('SIGINT', once);
    process.off('message', onMessage);
    if (timer) clearInterval(timer);
  };
}

function ignoreMissing(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
