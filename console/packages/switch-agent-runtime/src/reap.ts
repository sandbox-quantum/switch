/**
 * Clearing up runtimes that outlived the host that spawned them.
 *
 * A runtime is started three deep — host → `npm exec` → runtime — and for a
 * long time none of them noticed when the host died: the stdio transport
 * reports only an orderly close, so a killed or crashed host left the runtime
 * serving nobody, holding a port and beating a heartbeat at a Switch it could
 * no longer reach. One machine accumulated 486 of them, 3.5 GB, over 18 days.
 *
 * `bin.ts` now exits on its own for all of those cases, so nothing this module
 * kills should ever exist again. It is here for the ones already running: every
 * published version up to 0.3.2 lacks that fix and will sit there until the
 * machine reboots. A new runtime clears them out on its way up.
 *
 * The signal is the process tree, not anything on disk. When the host dies its
 * `npm exec` wrapper is reparented to init while the runtime carries on
 * pointing at a wrapper that is alive but orphaned — so "is the parent dead?"
 * is the wrong question and would have missed the two worst offenders on the
 * machine above. Reaching init without passing a live host is the right one.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type ProcessRow = { pid: number; ppid: number; command: string };

/**
 * The two shapes this process launches as, matched from the start of the
 * command rather than anywhere in it.
 *
 * A substring test is not safe here: any shell whose command line merely
 * *mentions* the package matches one — a `zsh -c` running an install or a grep
 * for it, say — and if that shell were orphaned the reaper would kill it.
 * Anchoring on argv[0] separates "is this process the runtime" from "does this
 * process talk about the runtime".
 *
 * Matching both shapes with one predicate is deliberate: the wrapper carries no
 * meaning of its own, so the chain walk can treat the pair as a unit.
 */
const RUNTIME_PATTERNS = [
  // node /…/node_modules/.bin/switch-agent-runtime
  /^(?:\S*\/)?(?:node\s+)?\S*\/node_modules\/\.bin\/switch-agent-runtime(?:\s|$)/,
  // npm exec @scope/switch-agent-runtime@1.2.3   |   npx -y @scope/…@1.2.3
  /^(?:\S*\/)?(?:npm|npx)\s+.*\bswitch-agent-runtime@/,
];

function isRuntimeProcess(command: string): boolean {
  return RUNTIME_PATTERNS.some((pattern) => pattern.test(command));
}

/** Parse `ps -axo pid=,ppid=,command=`. */
export function parseProcessTable(stdout: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S.*)$/.exec(line);
    if (!match) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return rows;
}

/** Every ancestor of `pid`, and `pid` itself. */
function chainFrom(pid: number, byPid: Map<number, ProcessRow>): Set<number> {
  const chain = new Set<number>([pid]);
  let current = byPid.get(pid)?.ppid ?? 0;
  while (current > 1 && !chain.has(current)) {
    chain.add(current);
    current = byPid.get(current)?.ppid ?? 0;
  }
  return chain;
}

/**
 * Whether some live process outside this runtime's own launch chain owns it.
 *
 * Walks up through the wrapper — which carries the same marker — and stops at
 * the first ancestor that does not. That ancestor is the host: if we reach init
 * without finding one, nobody is left to serve.
 */
function hasLiveHost(row: ProcessRow, byPid: Map<number, ProcessRow>): boolean {
  const seen = new Set<number>();
  let current = row.ppid;

  while (current > 1) {
    if (seen.has(current)) return false;
    seen.add(current);

    const parent = byPid.get(current);
    // Gone between the snapshot and now: it cannot be a host that is still
    // waiting on this runtime.
    if (!parent) return false;
    if (!isRuntimeProcess(parent.command)) return true;

    current = parent.ppid;
  }

  return false;
}

/**
 * The runtime and wrapper processes with no host left, newest ancestor first.
 *
 * `selfPid`'s own chain is excluded outright rather than left to the walk. The
 * walk would spare it anyway — we were just spawned, so our host is alive — but
 * a reaper that can reach itself is one bad predicate away from killing the
 * session it was started to serve.
 */
export function findOrphanedRuntimes(rows: ProcessRow[], selfPid: number): number[] {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const protectedPids = chainFrom(selfPid, byPid);

  const orphaned: number[] = [];
  for (const row of rows) {
    if (!isRuntimeProcess(row.command)) continue;
    if (protectedPids.has(row.pid)) continue;
    if (hasLiveHost(row, byPid)) continue;
    orphaned.push(row.pid);
  }
  return orphaned;
}

/**
 * Session directories whose owning process is gone.
 *
 * Pure litter: a runtime killed outright never runs `unpublishPort`, and the
 * directories accumulate one per session forever (8071 on the machine that
 * prompted this). Nothing reads a directory whose pid is dead, so removing them
 * is safe independently of anything above.
 */
export function staleSessionDirs(
  entries: string[],
  isAlive: (pid: number) => boolean,
  keep: string | null
): string[] {
  return entries.filter(
    (entry) => entry !== keep && /^\d+$/.test(entry) && !isAlive(Number(entry))
  );
}

/** Whether a pid exists, without signalling it. */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means it exists and belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** What one sweep did, for the caller to report however it reports things. */
export type ReapOutcome = {
  reaped: number;
  removedSessionDirs: number;
  /** Enumerated rather than free text: both callers log a code, not a sentence. */
  failures: Array<{ stage: 'scan' | 'sweep'; error: unknown }>;
};

/**
 * Clear up after runtimes that outlived their host.
 *
 * Returns what it did instead of logging it. There are two callers with two
 * different ideas of a log line — the runtime writes prose to stderr, the app
 * wants a structured event — and neither should have to be threaded through
 * here as a callback.
 *
 * Best-effort throughout: this runs beside something already serving a user and
 * must never be able to fail it, so every failure is collected rather than
 * thrown.
 *
 * `ps` covers macOS and Linux; Windows has no equivalent worth reimplementing
 * for a population that reboots away, so only the directory sweep runs there.
 */
export async function reapOrphanedRuntimes(options: {
  sessionsRoot: string;
  /**
   * A session directory to spare — the caller's own, when the caller is itself
   * a runtime. The app has none and passes null.
   */
  keepSessionDir: string | null;
}): Promise<ReapOutcome> {
  const { sessionsRoot, keepSessionDir } = options;
  const outcome: ReapOutcome = { reaped: 0, removedSessionDirs: 0, failures: [] };

  if (process.platform !== 'win32') {
    try {
      const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,ppid=,command=']);
      for (const pid of findOrphanedRuntimes(parseProcessTable(stdout), process.pid)) {
        try {
          // Every version being reaped predates the shutdown handlers, so this
          // lands on node's default disposition and terminates them.
          process.kill(pid, 'SIGTERM');
          outcome.reaped += 1;
        } catch {
          // Already gone, or not ours to signal.
        }
      }
    } catch (error) {
      outcome.failures.push({ stage: 'scan', error });
    }
  }

  try {
    const entries = await fs.readdir(sessionsRoot);
    const keep = keepSessionDir === null ? null : path.basename(keepSessionDir);
    for (const entry of staleSessionDirs(entries, pidIsAlive, keep)) {
      // Awaited one at a time rather than in bulk: there can be thousands, and
      // this shares an event loop with something already serving.
      await fs.rm(path.join(sessionsRoot, entry), { recursive: true, force: true });
      outcome.removedSessionDirs += 1;
    }
  } catch (error) {
    // Nothing has ever run here; there is nothing to clean and nothing to say.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      outcome.failures.push({ stage: 'sweep', error });
    }
  }

  return outcome;
}
