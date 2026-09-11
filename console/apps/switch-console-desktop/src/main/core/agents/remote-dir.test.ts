import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';

const stat = vi.hoisted(() => vi.fn());
const close = vi.hoisted(() => vi.fn());
const constructedWith = vi.hoisted(() => [] as string[]);

vi.mock('@main/core/fs/impl/ssh-fs', () => ({
  SshFileSystem: class {
    constructor(_proxy: unknown, base: string) {
      constructedWith.push(base);
    }
    stat = stat;
    close = close;
  },
}));
vi.mock('@main/core/locations/location-transport', () => ({
  sshConnectionIdForHost: (host: string) => `conn:${host}`,
}));
vi.mock('@main/core/ssh/connect/connect-agent-ssh', () => ({
  ensureSshConnected: vi.fn(async () => ({})),
}));

const { inspectRemoteDir } = await import('./remote-dir');

/** Report `paths` as existing directories and everything else as absent. */
function existingDirs(paths: string[]) {
  stat.mockImplementation(async (path: string) =>
    paths.includes(path) ? { path, type: 'dir' } : null
  );
}

const REPO_DIR = '/home/ubuntu/switch-agents/internal-deployments';

beforeEach(() => {
  vi.clearAllMocks();
  constructedWith.length = 0;
});

describe('inspectRemoteDir', () => {
  it('reports an existing directory', async () => {
    existingDirs([REPO_DIR]);

    expect(await inspectRemoteDir('host', REPO_DIR)).toEqual({
      dir: REPO_DIR,
      status: 'directory',
    });
  });

  // Long-standing behaviour, and not something this ticket should take away:
  // recursive mkdir may create the working directory itself, just not its
  // ancestors, so a missing leaf under an existing parent needs no intervention.
  it('reports a missing directory whose parent exists as creatable', async () => {
    existingDirs(['/home/ubuntu/switch-agents']);

    expect(await inspectRemoteDir('host', REPO_DIR)).toEqual({
      dir: REPO_DIR,
      status: 'creatable',
    });
  });

  // The ticket's repro: the parent is missing too, so the write cannot recover.
  it('reports a missing directory whose parent is also missing', async () => {
    existingDirs(['/home/ubuntu']);

    expect(await inspectRemoteDir('host', REPO_DIR)).toEqual({
      dir: REPO_DIR,
      status: 'missing',
    });
    // Opened at the host root: an FS rooted at the missing directory could not
    // stat its way out to look at the parent.
    expect(constructedWith).toEqual(['/']);
  });

  it('reports a path that is a file', async () => {
    stat.mockImplementation(async (path: string) =>
      path === REPO_DIR ? { path, type: 'file' } : null
    );

    expect(await inspectRemoteDir('host', REPO_DIR)).toEqual({ dir: REPO_DIR, status: 'file' });
  });

  it('refuses a directory whose parent is a file', async () => {
    stat.mockImplementation(async (path: string) =>
      path === '/home/ubuntu/switch-agents' ? { path, type: 'file' } : null
    );

    expect(await inspectRemoteDir('host', REPO_DIR)).toEqual({ dir: REPO_DIR, status: 'missing' });
  });

  // An unreadable path is not a missing one; saying so would send the user off
  // to create a directory that is already there.
  it('propagates a probe failure that is not absence', async () => {
    stat.mockRejectedValue(
      new FileSystemError('Permission denied: /home', FileSystemErrorCodes.PERMISSION_DENIED)
    );

    await expect(inspectRemoteDir('host', REPO_DIR)).rejects.toThrow('Permission denied');
  });

  it('rejects a relative path rather than resolving it against the login dir', async () => {
    await expect(inspectRemoteDir('host', 'switch-agents/repo')).rejects.toThrow(
      'must be an absolute path'
    );
    expect(stat).not.toHaveBeenCalled();
  });

  it('normalises a trailing slash', async () => {
    existingDirs([REPO_DIR]);

    expect(await inspectRemoteDir('host', `${REPO_DIR}/`)).toMatchObject({ dir: REPO_DIR });
  });

  it('closes the SFTP channel even when the probe throws', async () => {
    stat.mockRejectedValue(new Error('boom'));

    await expect(inspectRemoteDir('host', REPO_DIR)).rejects.toThrow('boom');
    expect(close).toHaveBeenCalled();
  });
});
