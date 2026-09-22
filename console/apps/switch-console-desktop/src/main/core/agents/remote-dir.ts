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
 * Two stats decide it: whether the directory is there, and if not, whether its
 * parent is. A missing directory under an existing parent is created by the
 * first credentials write; a missing parent is not, because the working
 * directory's own FS is rooted at the directory and its recursive mkdir stops
 * there.
 *
 * The FS here is rooted at `/` because one rooted at a missing directory cannot
 * stat its way out to its parent. That is the only such handle in the app, and
 * `resolveRemotePath` cannot reject anything on it — keep it stat-only.
 *
 * A path that cannot be stat'd for a reason other than absence (permission
 * denied, dead connection) propagates rather than being reported as `missing`.
 * An unreadable path is not a missing one, and saying so would send the user off
 * to fix the wrong problem.
 *
 * Existence is not writability: a non-writable directory reads as `directory`
 * and the write still fails after the identity is minted. Closing that needs a
 * probe write or `test -w`; mode bits would not account for the effective user.
 */
export async function inspectRemoteDir(sshHost: string, dir: string): Promise<RemoteDirInspection> {
  if (!isAbsoluteRemoteDir(dir)) {
    return { dir, status: 'relative' };
  }
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
