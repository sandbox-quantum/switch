import { rm } from 'node:fs/promises';

/**
 * How many times a refused removal is retried, and the delay before the
 * first retry (`rm` doubles it after each attempt). On Windows, a directory
 * or file a process just finished with can stay briefly unremovable after
 * that process (or this one) believes it is done with it — a watcher's
 * handle closing on the libuv thread pool, a deferred antivirus scan, a
 * child process whose own close of a database file outlasts its exit — so a
 * removal right on a test's heels can answer `EBUSY` or `ENOTEMPTY` for a
 * few hundred milliseconds before the directory is really free.
 */
const REMOVE_MAX_RETRIES = 5;
const REMOVE_RETRY_DELAY_MS = 100;

/**
 * Removes a test's temp root, tolerating a removal that is briefly refused
 * rather than failing the test over it.
 *
 * This is not a substitute for stopping what the test started: a host, its
 * child processes, or anything else still writing into the root has to be
 * stopped and awaited first. Retrying here only covers the platform's own lag
 * in letting go of a handle that is already closed; it would mask a real
 * leak, by passing just as slowly, if something is still writing when it
 * runs.
 */
export async function removeTestRoot(root: string): Promise<void> {
  await rm(root, {
    recursive: true,
    force: true,
    maxRetries: REMOVE_MAX_RETRIES,
    retryDelay: REMOVE_RETRY_DELAY_MS,
  });
}
