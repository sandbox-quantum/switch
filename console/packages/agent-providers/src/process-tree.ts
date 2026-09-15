/**
 * Stopping a spawned process and everything it spawned.
 *
 * Kept apart from `host/process-fence`, which reaches for `ps` at import time:
 * this is loaded by every provider transport and must not drag that in.
 */

/** POSIX gives a detached child its own process group; Windows has none. */
export const GROUPED_CHILDREN = process.platform !== 'win32';

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
  options: { grouped: boolean; escalateAfterMs: number; deadlineMs: number; description: string }
): Promise<void> {
  const group = options.grouped && typeof child.pid === 'number' ? -child.pid : null;
  const sweep = (signal: NodeJS.Signals) => {
    if (group === null) return;
    try {
      process.kill(group, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
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
