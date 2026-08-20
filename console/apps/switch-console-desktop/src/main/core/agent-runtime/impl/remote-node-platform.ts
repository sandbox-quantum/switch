import type { IExecutionContext } from '@main/core/execution-context/types';
import { log } from '@main/lib/logger';

/**
 * The remote host's platform, in Node's `process.platform` vocabulary.
 *
 * Anything Switch Console generates for a session to *run* — hook commands above all —
 * has to be built for the machine the session runs on, not for the machine
 * building it. A Windows console driving a Linux VM would otherwise SFTP
 * `cmd.exe /d /c "... powershell.exe ..."` into the VM's agent config, where
 * every hook fails silently.
 *
 * Cached per connection: the answer cannot change for the life of an SSH
 * connection, and hook installs run on every session spawn.
 */
const probes = new Map<string, Promise<NodeJS.Platform>>();

async function probeRemotePlatform(ctx: IExecutionContext): Promise<NodeJS.Platform> {
  const { stdout } = await ctx.exec('uname', ['-s']);
  const kernel = stdout.trim().toLowerCase();
  if (kernel.includes('darwin')) return 'darwin';
  if (kernel.includes('linux')) return 'linux';
  throw new Error(`unrecognised remote kernel '${stdout.trim()}'`);
}

export function remoteNodePlatform(
  connectionId: string,
  ctx: IExecutionContext
): Promise<NodeJS.Platform> {
  const cached = probes.get(connectionId);
  if (cached) return cached;
  const probe = probeRemotePlatform(ctx).catch((error) => {
    probes.delete(connectionId);
    // Every remote host Switch Console supports is POSIX, so this is the useful guess —
    // but say so, because a wrong one costs the session all of its hooks.
    log.warn('remoteNodePlatform: uname failed, assuming linux', {
      connectionId,
      error: String((error as Error)?.message ?? error),
    });
    return 'linux' as NodeJS.Platform;
  });
  probes.set(connectionId, probe);
  return probe;
}
