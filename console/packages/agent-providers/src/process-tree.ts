/**
 * Stopping a spawned process and everything it spawned.
 *
 * Kept apart from `host/process-fence`, which reaches for `ps` at import time:
 * this is loaded by every provider transport and must not drag that in.
 */

/** POSIX gives a detached child its own process group; Windows has none. */
export const GROUPED_CHILDREN = process.platform !== 'win32';

/** This process's own group, which must never be swept. */
async function ownProcessGroupId(): Promise<number> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('ps', ['-o', 'pgid=', '-p', String(process.pid)], (error, stdout) => {
      resolve(error ? process.pid : Number(stdout.trim()) || process.pid);
    });
  });
}

/**
 * The process groups this process has spawned, by the session they belong to.
 *
 * A resident host is SIGKILLed with its room sessions' provider groups still
 * running: those groups are not in the host's own group and outlive its fence.
 * Their pgids are therefore written to the session's state directory as they are
 * spawned, so the next host can sweep them before it claims anything — a
 * replacement that quiesced a session while its old provider was still executing
 * is exactly the failure the whole ownership scheme exists to prevent.
 *
 * Attribution is by session id, which every provider spawn already carries. A
 * spawn with no session — the readiness probe — records nothing: it is torn down
 * within its own call and never outlives a host.
 */
const spawnedGroups = new Map<string, Set<number>>();
let groupListener: (sessionId: string, pgids: number[]) => void = () => {};

/** One resident host per process registers the sink that makes the record durable. */
export function onProcessGroupsChanged(listener: (sessionId: string, pgids: number[]) => void) {
  groupListener = listener;
}

export function processGroupsFor(sessionId: string): number[] {
  return [...(spawnedGroups.get(sessionId) ?? [])];
}

export function registerProcessGroup(sessionId: string | null, pid: number | undefined): void {
  if (!sessionId || typeof pid !== 'number' || pid <= 1 || !GROUPED_CHILDREN) return;
  const groups = spawnedGroups.get(sessionId) ?? new Set<number>();
  groups.add(pid);
  spawnedGroups.set(sessionId, groups);
  groupListener(sessionId, [...groups]);
}

export function forgetProcessGroup(sessionId: string | null, pid: number | undefined): void {
  if (!sessionId || typeof pid !== 'number') return;
  const groups = spawnedGroups.get(sessionId);
  if (!groups?.delete(pid)) return;
  if (groups.size === 0) spawnedGroups.delete(sessionId);
  groupListener(sessionId, [...groups]);
}

/**
 * Whether a recorded pgid may be signalled at all.
 *
 * `kill(-1, …)` is not "no group": POSIX defines it as every process the caller
 * may signal, so one corrupt or truncated record would take the user's whole
 * session down. `kill(0, …)` is this process's own group, which contains the
 * host. Both are refused, along with anything that is not a plausible pid — a
 * record this host cannot trust is a record it must not act on.
 */
function signallableGroup(pgid: unknown, ownGroup: number): boolean {
  if (typeof pgid !== 'number' || !Number.isSafeInteger(pgid)) return false;
  if (pgid <= 1) return false;
  if (pgid === ownGroup || pgid === process.pid) return false;
  return true;
}

/**
 * ESRCH and EPERM both mean this group holds nothing of ours any more.
 *
 * A process can always signal the children it spawned, so EPERM on a pgid this
 * process recorded says the group it spawned is gone and the id has been reused
 * by someone else's — signalling it further would be aimed at a stranger.
 */
function gone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ESRCH' || code === 'EPERM';
}

function groupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    if (gone(error)) return false;
    throw error;
  }
}

/**
 * Terminate process groups left behind by a host that is no longer running.
 *
 * Throws when a group cannot be proven gone: its caller must refuse to claim the
 * session rather than assume the old provider stopped.
 */
export async function sweepProcessGroups(pgids: number[], description: string): Promise<void> {
  if (!GROUPED_CHILDREN || pgids.length === 0) return;
  const ownGroup = await ownProcessGroupId();
  const refused = pgids.filter((pgid) => !signallableGroup(pgid, ownGroup));
  if (refused.length)
    throw new Error(
      `${description}: refusing to signal process ${refused.length === 1 ? 'group' : 'groups'} ${refused.join(', ')}. A recorded group must be one this host spawned, never the whole session or its own.`
    );
  const live = pgids.filter(groupExists);
  if (live.length === 0) return;
  for (const pgid of live)
    try {
      process.kill(-pgid, 'SIGTERM');
    } catch (error) {
      if (!gone(error)) throw error;
    }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!live.some(groupExists)) return;
    if (attempt === 4)
      for (const pgid of live)
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch (error) {
          if (!gone(error)) throw error;
        }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(
    `${description}: process groups ${live.filter(groupExists).join(', ')} did not exit. Their processes could not be proven stopped.`
  );
}

type StoppableChild = {
  pid?: number | undefined;
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  kill(signal: NodeJS.Signals): unknown;
};

/**
 * Stop a child and everything it spawned.
 *
 * Signalling the child alone is not enough: one that needs SIGKILL leaves its
 * own children — an MCP runtime, a shell started for a tool call — orphaned and
 * running. A child spawned `detached` leads its own process group, so once the
 * leader is down the group is swept for whatever outlived it. The group is only
 * ever signalled through a pid this process spawned; the leader itself is
 * signalled through the child handle, which is also what makes this usable
 * against a stand-in in tests.
 *
 * A leader that will not go is reported rather than assumed gone: its caller
 * keeps the session's ownership instead of letting anything else conclude that
 * the provider stopped.
 */
export async function stopProcessTree(
  child: StoppableChild,
  options: {
    grouped: boolean;
    escalateAfterMs: number;
    deadlineMs: number;
    description: string;
    /** Skip waiting on a leader that has already gone; still sweep its group. */
    leaderExited?: boolean;
  }
): Promise<void> {
  // Never `-1`: that is every process this user owns, not "no group".
  const group =
    options.grouped && typeof child.pid === 'number' && child.pid > 1 ? -child.pid : null;
  const sweep = (signal: NodeJS.Signals) => {
    if (group === null) return;
    try {
      process.kill(group, signal);
    } catch (error) {
      if (!gone(error)) throw error;
    }
  };
  if (options.leaderExited) {
    // A leader that exited leaves its grandchildren behind; the group is the
    // only handle on them, and skipping this is how they were orphaned.
    sweep('SIGKILL');
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const escalate = setTimeout(() => {
      child.kill('SIGKILL');
      sweep('SIGKILL');
    }, options.escalateAfterMs);
    const expired = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `${options.description} did not exit after termination; its processes could not be proven stopped.`
        )
      );
    }, options.deadlineMs);
    const cleanup = () => {
      clearTimeout(escalate);
      clearTimeout(expired);
      child.removeListener('exit', exited);
    };
    const exited = () => {
      cleanup();
      resolve();
    };
    child.once('exit', exited);
    child.kill('SIGTERM');
  });
  sweep('SIGKILL');
}
