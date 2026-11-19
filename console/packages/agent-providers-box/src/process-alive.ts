/**
 * Where a probed pid came from, which decides what EPERM from signal 0 means.
 *
 * - `recorded`: a pid file or owner record that this app's own processes wrote.
 *   On Windows EPERM comes back for such a process when it runs in another
 *   elevation or session, so it is alive. On a box, unlike upstream, EPERM is
 *   rethrown: the controller and the agents run as different users (the split
 *   box's 2001 and 2000, a hosted machine's user per agent), so EPERM can come
 *   from a live process of ours as well as from an id another user reused.
 *   Neither alive nor gone is known, and nothing is judged on a guess.
 * - `any-user`: a pid that may belong to any user, or a process group. EPERM
 *   means it exists but this process may not signal it, so it is alive.
 */
export type PidOrigin = 'recorded' | 'any-user';

/**
 * Whether a process with this id exists, probed with signal 0: success is
 * alive, ESRCH is gone, EPERM is decided by `origin` (and rethrown for a
 * recorded pid off Windows), and any other error is rethrown.
 */
export function isProcessAlive(pid: number, origin: PidOrigin): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM' && (origin === 'any-user' || process.platform === 'win32')) return true;
    throw error;
  }
}

/**
 * `isProcessAlive` as source for a script run with `node -e` on a host, where
 * no package is installed: declares `const isProcessAlive` in the scope it is
 * placed in. The function reads nothing but `process`, so its own source runs
 * there unchanged.
 */
export const IS_PROCESS_ALIVE = `const isProcessAlive = ${isProcessAlive.toString()};\n`;
