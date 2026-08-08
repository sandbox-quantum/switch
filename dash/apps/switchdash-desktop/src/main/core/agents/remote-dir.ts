import { posix as pathPosix } from 'node:path';
import { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { sshConnectionIdForHost } from '@main/core/locations/location-transport';
import { ensureSshConnected } from '@main/core/ssh/connect/connect-agent-ssh';
import type { RemoteDirInspection } from '@shared/core/remote-hosts/remote-dir';

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
 * missing directory cannot stat its way out to look at the parent.
 *
 * `dir` must be absolute — a relative path would resolve against whatever
 * directory the SSH session happens to start in, which is not a thing the user
 * chose.
 *
 * A path that cannot be stat'd for any reason *other* than absence (permission
 * denied, dead connection) propagates rather than being reported as `missing`.
 * An unreadable path is not a missing one, and saying so would send the user
 * off to fix the wrong problem.
 */
export async function inspectRemoteDir(sshHost: string, dir: string): Promise<RemoteDirInspection> {
  if (!pathPosix.isAbsolute(dir)) {
    throw new Error(`Remote working directory must be an absolute path: ${dir}`);
  }
  const normalized = pathPosix.normalize(dir).replace(/\/+$/, '') || '/';

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
