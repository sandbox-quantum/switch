import { describe, expect, it, vi } from 'vitest';
import type { SshFileSystem } from '@main/core/fs/impl/ssh-fs';
import { FileSystemError, FileSystemErrorCodes } from '@main/core/fs/types';
import { createRemotePluginFs } from './remote-plugin-fs';

/** Build a PluginFs over a stubbed SshFileSystem with the given method impls. */
function adapter(stub: Partial<SshFileSystem>) {
  return createRemotePluginFs(stub as unknown as SshFileSystem);
}

describe('createRemotePluginFs', () => {
  it('read returns the file content', async () => {
    const read = vi.fn(async () => ({ content: 'hello', truncated: false, totalSize: 5 }));
    const fs = adapter({ read });
    expect(await fs.read('.claude/agents/x.md')).toBe('hello');
    expect(read).toHaveBeenCalledWith('.claude/agents/x.md', expect.any(Number));
  });

  it('read returns null when the file does not exist', async () => {
    const fs = adapter({
      read: vi.fn(async () => {
        throw new FileSystemError('No such file', FileSystemErrorCodes.NOT_FOUND);
      }),
    });
    expect(await fs.read('nope')).toBeNull();
  });

  it('read propagates transport failures instead of reporting a missing file', async () => {
    const fs = adapter({
      read: vi.fn(async () => {
        throw new FileSystemError('channel open failure', FileSystemErrorCodes.CONNECTION_ERROR);
      }),
    });
    await expect(fs.read('x')).rejects.toThrow(/channel open failure/);
  });

  it('read propagates untyped failures (e.g. a dropped SSH connection)', async () => {
    const fs = adapter({
      read: vi.fn(async () => {
        throw new Error('SSH connection is not available');
      }),
    });
    await expect(fs.read('x')).rejects.toThrow(/SSH connection is not available/);
  });

  it('write resolves on success', async () => {
    const write = vi.fn(async () => ({ success: true, bytesWritten: 3 }));
    const fs = adapter({ write });
    await expect(fs.write('a', 'b')).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledWith('a', 'b');
  });

  it('write throws (fails loud) when the write is unsuccessful', async () => {
    const fs = adapter({
      write: vi.fn(async () => ({ success: false, bytesWritten: 0, error: 'disk full' })),
    });
    await expect(fs.write('a', 'b')).rejects.toThrow(/disk full/);
  });

  it('delete removes the path and ignores a missing file', async () => {
    // The literal SshFileSystem.remove produces when its stat finds nothing.
    const remove = vi.fn(async () => ({ success: false, error: 'File not found: gone' }));
    const fs = adapter({ remove });
    await expect(fs.delete('gone')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('gone');
  });

  it('delete resolves when the remove succeeds', async () => {
    const fs = adapter({ remove: vi.fn(async () => ({ success: true })) });
    await expect(fs.delete('x')).resolves.toBeUndefined();
  });

  it('delete throws (fails loud) when the file is there but cannot be removed', async () => {
    // `remove` reports failure through its result rather than throwing, so a
    // caller that ignores the result reports an undeletable Switch token as
    // revoked.
    const fs = adapter({
      remove: vi.fn(async () => ({ success: false, error: 'Permission denied' })),
    });
    await expect(fs.delete('.switch/agents/a.json')).rejects.toThrow(/Permission denied/);
  });

  it('exists passes through', async () => {
    const fs = adapter({ exists: vi.fn(async () => true) });
    expect(await fs.exists('x')).toBe(true);
  });

  it('list maps root-relative entries back to basenames', async () => {
    const list = vi.fn(async () => ({
      entries: [
        { path: '.claude/switch-subagents/a.settings.json', type: 'file' as const },
        { path: '.claude/switch-subagents/b.settings.json', type: 'file' as const },
      ],
      total: 2,
    }));
    const fs = adapter({ list });
    expect(await fs.list('.claude/switch-subagents')).toEqual([
      'a.settings.json',
      'b.settings.json',
    ]);
    expect(list).toHaveBeenCalledWith('.claude/switch-subagents', { includeHidden: true });
  });

  it('list returns [] when the directory is missing', async () => {
    const fs = adapter({
      list: vi.fn(async () => {
        throw new Error('No such file');
      }),
    });
    expect(await fs.list('missing')).toEqual([]);
  });
});
