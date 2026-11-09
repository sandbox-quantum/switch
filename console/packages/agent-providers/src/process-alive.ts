/**
 * Whether a process with this id exists, probed with signal 0. EPERM means it
 * exists but this process may not signal it (another user, or on Windows
 * another elevation or session), so it counts as alive.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}
