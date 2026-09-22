import { posix as pathPosix } from 'node:path';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import {
  isAbsoluteRemoteDir,
  normalizeRemoteDir,
  type RemoteDirInspection,
} from '@shared/core/remote-hosts/remote-dir';

/**
 * Inspect a prospective remote working directory on `sshHost` (CHOO-1416).
 *
 * Only two stats, because only two things decide the outcome: whether the
 * directory is there, and — if not — whether its parent is. A missing
 * directory under an existing parent is created by the first credentials
 * write, as it always has been; a missing parent is not, because the
 * working directory's own FS is rooted at the directory and its recursive
 * mkdir stops there.
 *
 * The FS here is opened at the host root instead, since one rooted at a
 * missing directory cannot stat its way out to look at the parent. That makes
 * it the only `SshFileSystem` in the app whose base is `/`, so
 * `resolveRemotePath`'s containment check cannot reject anything on this
 * handle: keep the two `stat` calls below the only thing done with it, and keep
 * it inside the `finally` that closes it. Anything here that needs to write
 * wants its own fs rooted at the directory it writes to.
 *
 * A relative `dir` is refused as `relative` rather than inspected: it would
 * resolve against whatever directory the SSH session happens to start in, which
 * is not a thing the user chose. It is a returned status rather than a throw so
 * it reaches the user as a sentence naming the path, like every other refusal
 * here — a throw arrives as the generic "nothing was created" toast carrying a
 * raw error string, which is the outcome this check exists to remove.
 *
 * A path that cannot be stat'd for any reason *other* than absence (permission
 * denied, dead connection) propagates rather than being reported as `missing`.
 * An unreadable path is not a missing one, and saying so would send the user
 * off to fix the wrong problem.
 *
 * What this does NOT answer is whether the directory can be **written**. An
 * existing but non-writable directory reads as `directory` and the write still
 * fails after the identity is minted — the CHOO-1416 failure mode, narrowed but
 * not closed. Answering it needs a probe write or a `test -w`, neither of which
 * this stat-only probe does; it is deliberately left to a follow-up rather than
 * guessed at from mode bits, which do not account for the effective user.
 */
export async function inspectRemoteDir(sshHost: string, dir: string): Promise<RemoteDirInspection> {
  if (!isAbsoluteRemoteDir(dir)) {
    return { dir, status: 'relative' };
  }
  // The same normalizer `addAgent` settles on, so the path reported back is the
  // one the caller already keyed everything else by.
  const normalized = normalizeRemoteDir(dir);

  const proxy = await ensureSshConnected(sshConnectionIdForHost(sshHost), sshHost);
  const fs = new SshFileSystem(proxy, '/');
  try {
    const entry = await fs.stat(normalized);
    if (entry) {
      return { dir: normalized, status: entry.type === 'dir' ? 'directory' : 'file' };
    }

    const parent = await fs.stat(pathPosix.dirname(normalized));
    return { dir: normalized, status: parent?.type === 'dir' ? 'creatable' : 'missing' };
  } finally {
    fs.close();
  }
}
