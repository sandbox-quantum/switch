import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSystemErrorCodes, type FileEntry, type FileListResult } from '../types';
import { SshFileSystem } from './ssh-fs';

const h = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('@main/lib/logger', () => ({
  log: { warn: h.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type SftpMkdirError = Error & { code?: number };

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

function makeMkdirFs(errors: Array<SftpMkdirError | undefined>) {
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
    fs: new SshFileSystem(proxy as never, '/repo'),
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

/** What an SFTP server answers for a path that is not there. */
const noSuchFile = () => Object.assign(new Error('No such file'), { code: 2 });
/** What an SFTP server answers for a path this account may not change. */
const permissionDenied = () => Object.assign(new Error('Permission denied'), { code: 3 });

function makeSecretFs(
  options: { renameThrows?: Error; missing?: string[]; denied?: string[]; entries?: string[] } = {}
) {
  const missing = options.missing ?? [];
  const denied = options.denied ?? [];
  const calls: unknown[][] = [];
  const handle = Buffer.from('handle');
  const step = (name: string) =>
    vi.fn((...args: unknown[]) => {
      const callback = args.pop() as (error?: Error) => void;
      calls.push([name, ...args]);
      const target = args[0] as string;
      callback(
        missing.includes(target)
          ? noSuchFile()
          : denied.includes(target)
            ? permissionDenied()
            : undefined
      );
    });
  const sftp = {
    on: vi.fn(),
    readdir: vi.fn(
      (
        dir: string,
        callback: (error: Error | undefined, list?: { filename: string }[]) => void
      ) => {
        calls.push(['readdir', dir]);
        if (missing.includes(dir)) callback(noSuchFile());
        else
          callback(
            undefined,
            (options.entries ?? []).map((filename) => ({ filename }))
          );
      }
    ),
    mkdir: vi.fn((dirPath: string, callback: (error?: Error) => void) => {
      calls.push(['mkdir', dirPath]);
      callback(new Error('File exists'));
    }),
    chmod: step('chmod'),
    open: vi.fn(
      (
        path: string,
        flags: string,
        attrs: unknown,
        callback: (error: Error | undefined, handle: Buffer) => void
      ) => {
        calls.push(['open', path, flags, attrs]);
        callback(undefined, handle);
      }
    ),
    fchmod: step('fchmod'),
    write: step('write'),
    close: step('close'),
    // ssh2 throws, rather than calling back, when the server lacks posix-rename.
    ext_openssh_rename: options.renameThrows
      ? vi.fn((from: string, to: string) => {
          calls.push(['rename', from, to]);
          throw options.renameThrows;
        })
      : step('rename'),
    unlink: step('unlink'),
  };
  const proxy = {
    sftp: vi.fn((callback: (error: Error | undefined, sftp: unknown) => void) => {
      callback(undefined, sftp);
    }),
  };
  return { fs: new SshFileSystem(proxy as never, '/repo'), calls, handle };
}

describe('SshFileSystem.writeSecret', () => {
  it('writes a 0600 temporary file and renames it over the target, in a 0700 directory', async () => {
    const { fs, calls, handle } = makeSecretFs();

    await fs.writeSecret('.switch/agents/a.json', 'token');

    const temporary = calls.find((call) => call[0] === 'open')?.[1] as string;
    expect(temporary).toMatch(/^\/repo\/\.switch\/agents\/a\.json\.[0-9a-f-]{36}$/);
    expect(calls.map((call) => call[0])).toEqual([
      'mkdir',
      'chmod',
      'open',
      'fchmod',
      'write',
      'close',
      'rename',
    ]);
    expect(calls).toContainEqual(['chmod', '/repo/.switch/agents', 0o700]);
    expect(calls).toContainEqual(['open', temporary, 'wx', { mode: 0o600 }]);
    expect(calls).toContainEqual(['fchmod', handle, 0o600]);
    expect(String(calls.find((call) => call[0] === 'write')?.[2])).toBe('token');
    expect(calls).toContainEqual(['rename', temporary, '/repo/.switch/agents/a.json']);
  });

  it('writes the file and warns when its directory belongs to another account', async () => {
    const { fs, calls } = makeSecretFs({ denied: ['/repo/.switch/agents'] });

    await fs.writeSecret('.switch/agents/a.json', 'token');

    expect(calls.map((call) => call[0])).toEqual([
      'mkdir',
      'chmod',
      'open',
      'fchmod',
      'write',
      'close',
      'rename',
    ]);
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('another account'), {
      dir: '/repo/.switch/agents',
    });
  });

  it('removes the temporary file and fails when the server cannot rename over the target', async () => {
    const { fs, calls } = makeSecretFs({
      renameThrows: new Error('Server does not support this extended request'),
    });

    await expect(fs.writeSecret('.switch/agents/a.json', 'token')).rejects.toThrow(
      /does not support/
    );

    const temporary = calls.find((call) => call[0] === 'open')?.[1];
    expect(calls.at(-1)).toEqual(['unlink', temporary]);
  });

  it('rejects a path escape before reaching SFTP', async () => {
    const { fs, calls } = makeSecretFs();

    await expect(fs.writeSecret('../outside.json', 'token')).rejects.toMatchObject({
      code: FileSystemErrorCodes.PATH_ESCAPE,
    });
    expect(calls).toEqual([]);
  });
});

describe('SshFileSystem.protectSecret', () => {
  it('makes an existing file 0600 and its directory 0700, writing nothing', async () => {
    const { fs, calls } = makeSecretFs();

    expect(await fs.protectSecret('.switch/agents/a.json')).toBe(true);

    expect(calls).toEqual([
      ['chmod', '/repo/.switch/agents/a.json', 0o600],
      ['chmod', '/repo/.switch/agents', 0o700],
    ]);
  });

  it('leaves the directory alone when asked to protect only the file', async () => {
    const { fs, calls } = makeSecretFs();

    expect(await fs.protectSecret('.claude/settings.local.json', { fileOnly: true })).toBe(true);

    expect(calls).toEqual([['chmod', '/repo/.claude/settings.local.json', 0o600]]);
  });

  it('still fails when the file itself cannot be changed', async () => {
    const { fs } = makeSecretFs({ denied: ['/repo/.switch/agents/a.json'] });

    await expect(fs.protectSecret('.switch/agents/a.json')).rejects.toMatchObject({
      code: FileSystemErrorCodes.PERMISSION_DENIED,
    });
  });

  it('changes nothing and says so when there is no file', async () => {
    const { fs, calls } = makeSecretFs({ missing: ['/repo/.switch/agents/a.json'] });

    expect(await fs.protectSecret('.switch/agents/a.json')).toBe(false);

    expect(calls).toEqual([['chmod', '/repo/.switch/agents/a.json', 0o600]]);
  });
});

describe('SshFileSystem.removeSecretTemps', () => {
  const uuid = '0b6f1d2e-3c4a-4b5d-8e9f-a0b1c2d3e4f5';

  it('removes only the copies an interrupted secret write of the file left', async () => {
    const { fs, calls } = makeSecretFs({
      entries: ['a.json', `a.json.${uuid}`, 'a.json.bak', `a.json2.${uuid}`, `b.json.${uuid}`],
    });

    await fs.removeSecretTemps('.switch/agents/a.json');

    expect(calls).toEqual([
      ['readdir', '/repo/.switch/agents'],
      ['unlink', `/repo/.switch/agents/a.json.${uuid}`],
    ]);
  });

  it('resolves when the directory is not there', async () => {
    const { fs, calls } = makeSecretFs({ missing: ['/repo/.switch/agents'] });

    await expect(fs.removeSecretTemps('.switch/agents/a.json')).resolves.toBeUndefined();
    expect(calls).toEqual([['readdir', '/repo/.switch/agents']]);
  });

  it('resolves when a copy is gone by the time it is removed', async () => {
    const temporary = `/repo/.switch/agents/a.json.${uuid}`;
    const { fs } = makeSecretFs({ entries: [`a.json.${uuid}`], missing: [temporary] });

    await expect(fs.removeSecretTemps('.switch/agents/a.json')).resolves.toBeUndefined();
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
