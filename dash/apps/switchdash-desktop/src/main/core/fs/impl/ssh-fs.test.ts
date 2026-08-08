import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemErrorCodes, type FileEntry, type FileListResult } from '../types';
import { SshFileSystem } from './ssh-fs';

type SftpMkdirError = Error & { code?: number };

/** SSH_FX_NO_SUCH_FILE, as ssh2 reports a missing path. */
const SFTP_NO_SUCH_FILE = 2;

function noSuchFile(): SftpMkdirError {
  return Object.assign(new Error('No such file'), { code: SFTP_NO_SUCH_FILE });
}

function listResult(entries: FileEntry[]): FileListResult {
  return { entries, total: entries.length };
}

function fileEntry(path: string, mtimeMs: number, size = 1): FileEntry {
  return {
    path,
    type: 'file',
    size,
    mtime: new Date(mtimeMs),
    mode: 0o100644,
  };
}

function makeMkdirFs(errors: Array<SftpMkdirError | undefined>, base = '/repo') {
  const mkdirCalls: string[] = [];
  const sftp = {
    on: vi.fn(),
    mkdir: vi.fn((dirPath: string, callback: (error?: SftpMkdirError) => void) => {
      mkdirCalls.push(dirPath);
      callback(errors.shift());
    }),
  };
  const proxy = {
    sftp: vi.fn((callback: (error: Error | undefined, sftp: unknown) => void) => {
      callback(undefined, sftp);
    }),
  };

  return {
    fs: new SshFileSystem(proxy as never, base),
    mkdirCalls,
  };
}

function makeRemoveFs() {
  const execCommands: string[] = [];
  const sftp = {
    on: vi.fn(),
    stat: vi.fn((_path: string, callback: (error: Error | undefined, stats?: unknown) => void) => {
      callback(undefined, {
        isDirectory: () => true,
        size: 0,
        mtime: 0,
        atime: 0,
        mode: 0o040755,
      });
    }),
  };
  const proxy = {
    sftp: vi.fn((callback: (error: Error | undefined, sftp: unknown) => void) => {
      callback(undefined, sftp);
    }),
    getRemoteShellProfile: vi.fn(async () => ({ shell: '/bin/sh', env: {} })),
    exec: vi.fn(
      (command: string, callback: (error: Error | undefined, stream: EventEmitter) => void) => {
        execCommands.push(command);
        const stream = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
        stream.stderr = new EventEmitter();
        callback(undefined, stream);
        setImmediate(() => stream.emit('close', 0));
      }
    ),
  };

  return {
    fs: new SshFileSystem(proxy as never, '/repo'),
    execCommands,
    proxy,
  };
}

describe('SshFileSystem.mkdir', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('treats lowercase file exists as idempotent during recursive mkdir', async () => {
    const { fs } = makeMkdirFs([new Error('file exists')]);

    await expect(fs.mkdir('existing', { recursive: true })).resolves.toBeUndefined();
  });

  it('treats uppercase File exists as idempotent during recursive mkdir', async () => {
    const { fs } = makeMkdirFs([new Error('File exists')]);

    await expect(fs.mkdir('existing', { recursive: true })).resolves.toBeUndefined();
  });

  it('rejects non-EEXIST errors during recursive mkdir', async () => {
    const { fs } = makeMkdirFs([new Error('Permission denied')]);

    await expect(fs.mkdir('denied', { recursive: true })).rejects.toThrow('Permission denied');
  });

  it('creates missing parents when SFTP reports lowercase no such file', async () => {
    const { fs, mkdirCalls } = makeMkdirFs([new Error('no such file'), undefined, undefined]);

    await expect(fs.mkdir('parent/child', { recursive: true })).resolves.toBeUndefined();
    expect(mkdirCalls).toEqual(['/repo/parent/child', '/repo/parent', '/repo/parent/child']);
  });

  // Recursive mkdir stops at its own base: an FS rooted at an agent's working
  // directory must not be able to create that directory's ancestors. This is
  // the containment behaviour that made a missing parent surface as a bare
  // "File or directory not found" during remote agent creation (CHOO-1416).
  // The fix reports the missing directory before anything is written, via a
  // probe rooted at `/` in `remote-dir.ts`, rather than widening this guard.
  it('refuses to create parents above its base', async () => {
    const repoDir = '/home/ubuntu/switch-agents/internal-deployments';
    const { fs, mkdirCalls } = makeMkdirFs([noSuchFile(), noSuchFile(), noSuchFile()], repoDir);

    await expect(fs.mkdir('.switch/agents', { recursive: true })).rejects.toThrow(
      `File or directory not found: ${repoDir}`
    );
    // Walked up as far as the base and stopped there: creating the base's own
    // parent (`/home/ubuntu/switch-agents`) would escape the sandbox.
    expect(mkdirCalls).toEqual([`${repoDir}/.switch/agents`, `${repoDir}/.switch`, repoDir]);
  });

  it('creates ancestors freely when rooted at the filesystem root', async () => {
    const { fs, mkdirCalls } = makeMkdirFs([noSuchFile(), undefined, undefined], '/');

    await expect(
      fs.mkdir('/home/ubuntu/switch-agents/internal-deployments', { recursive: true })
    ).resolves.toBeUndefined();
    expect(mkdirCalls).toEqual([
      '/home/ubuntu/switch-agents/internal-deployments',
      '/home/ubuntu/switch-agents',
      '/home/ubuntu/switch-agents/internal-deployments',
    ]);
  });
});

describe('SshFileSystem.remove', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects traversal before recursive directory removal can reach SSH', async () => {
    const { fs, proxy } = makeRemoveFs();

    await expect(fs.remove('subdir/../../../outside', { recursive: true })).rejects.toMatchObject({
      code: FileSystemErrorCodes.PATH_ESCAPE,
    });

    expect(proxy.sftp).not.toHaveBeenCalled();
    expect(proxy.exec).not.toHaveBeenCalled();
  });

  it('removes directories recursively inside the location', async () => {
    const { fs, execCommands } = makeRemoveFs();

    await expect(fs.remove('subdir', { recursive: true })).resolves.toEqual({ success: true });

    expect(execCommands).toHaveLength(1);
    expect(execCommands[0]).toContain('rm -rf');
    expect(execCommands[0]).toContain('/repo/subdir');
  });
});

describe('SshFileSystem.watch', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('emits modify events when an existing polled file changes metadata', async () => {
    vi.useFakeTimers();

    const fs = new SshFileSystem({} as never, '/repo');
    vi.spyOn(fs, 'list')
      .mockResolvedValueOnce(listResult([fileEntry('notes.md', 1_000)]))
      .mockResolvedValueOnce(listResult([fileEntry('notes.md', 2_000)]));

    const events: Array<{ type: string; entryType: string; path: string }> = [];
    const watcher = fs.watch((batch) => events.push(...batch), { debounceMs: 10 });
    watcher.update(['']);

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([]);

    await vi.advanceTimersByTimeAsync(10);
    expect(events).toEqual([{ type: 'modify', entryType: 'file', path: 'notes.md' }]);

    watcher.close();
  });
});

function makeReaddirFs(base: string, filenames: string[]) {
  const readdirPaths: string[] = [];
  const sftp = {
    on: vi.fn(),
    readdir: vi.fn(
      (dirPath: string, callback: (error: Error | undefined, list?: unknown[]) => void) => {
        readdirPaths.push(dirPath);
        callback(
          undefined,
          filenames.map((filename) => ({
            filename,
            attrs: { isDirectory: () => false, size: 1, mtime: 0, atime: 0, mode: 0o100644 },
          }))
        );
      }
    ),
  };
  const proxy = {
    sftp: vi.fn((callback: (error: Error | undefined, sftp: unknown) => void) => {
      callback(undefined, sftp);
    }),
  };
  return { fs: new SshFileSystem(proxy as never, base), readdirPaths };
}

describe('SshFileSystem trailing-slash tolerance', () => {
  it('resolves + relativizes identically whether the base has a trailing slash or not', async () => {
    for (const base of ['/repo', '/repo/']) {
      const { fs, readdirPaths } = makeReaddirFs(base, ['code-reviewer.md']);
      const result = await fs.list('.claude/agents', { includeHidden: true });
      // No double slash from the base, and entries come back relative (a
      // trailing-slash base previously leaked absolute paths).
      expect(readdirPaths[0]).toBe('/repo/.claude/agents');
      expect(result.entries.map((e) => e.path)).toEqual(['.claude/agents/code-reviewer.md']);
    }
  });
});
