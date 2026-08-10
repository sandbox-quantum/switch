/**
 * One host probe at a time, across every caller (CHOO-1809).
 *
 * The setup runner accepts one operation per host and refuses the rest outright,
 * so two callers asking at once do not interleave — the loser throws "another
 * setup operation is already running". That reads as a fault on the host when it
 * is really a queueing failure on our side, and it filled the log with stacks
 * for steps nobody had asked about.
 *
 * Overlap is easy to cause without meaning to. The readiness gate probes the
 * steps it found stale, and every completed step pushes a new plan to the
 * renderer — which shortens the stale list, which re-renders the caller, which
 * asks again while the first pass is still running. Serialising here fixes that
 * class of collision wherever it comes from, rather than in each caller.
 */

const queues = new Map<string, Promise<unknown>>();

/**
 * Run `task` once every probe already queued for this host has settled.
 *
 * Failures do not poison the queue: the next task runs regardless of how the
 * previous one ended, while the caller still sees its own error.
 */
export function queueHostProbe<T>(sshHost: string, task: () => Promise<T>): Promise<T> {
  const previous = queues.get(sshHost) ?? Promise.resolve();
  // Same continuation for both outcomes — a rejected predecessor must not skip
  // the work behind it.
  const next = previous.then(task, task);
  queues.set(
    sshHost,
    next.catch(() => undefined)
  );
  return next;
}

/** Whether anything is queued for this host. Exposed for tests. */
export function hasQueuedProbe(sshHost: string): boolean {
  return queues.has(sshHost);
}

/** Drop a host's queue. Tests only — the queue is otherwise self-clearing. */
export function resetHostProbeQueue(sshHost?: string): void {
  if (sshHost) queues.delete(sshHost);
  else queues.clear();
}
