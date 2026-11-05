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

  it('a secret write goes through writeSecret, never the ordinary write', async () => {
    const write = vi.fn(async () => ({ success: true, bytesWritten: 5 }));
    const writeSecret = vi.fn(async () => {});
    const fs = adapter({ write, writeSecret });
    await fs.write('.switch/agents/a.json', 'token', { secret: true });
    expect(writeSecret).toHaveBeenCalledWith('.switch/agents/a.json', 'token');
    expect(write).not.toHaveBeenCalled();
  });

  it('a secret write that fails propagates rather than falling back to an ordinary one', async () => {
    const write = vi.fn(async () => ({ success: true, bytesWritten: 5 }));
    const fs = adapter({
      write,
      writeSecret: vi.fn(async () => {
        throw new Error('Server does not support this extended request');
      }),
    });
    await expect(fs.write('.switch/agents/a.json', 'token', { secret: true })).rejects.toThrow(
      /does not support/
    );
    expect(write).not.toHaveBeenCalled();
  });

  it('delete removes the path and ignores a missing file', async () => {
    // The literal SshFileSystem.remove produces when its stat finds nothing.
    const remove = vi.fn(async () => ({ success: false, error: 'File not found: gone' }));
    const fs = adapter({ remove, removeSecretTemps: vi.fn(async () => {}) });
    await expect(fs.delete('gone')).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledWith('gone');
  });

  it('delete resolves when the remove succeeds', async () => {
    const fs = adapter({
      remove: vi.fn(async () => ({ success: true })),
      removeSecretTemps: vi.fn(async () => {}),
    });
    await expect(fs.delete('x')).resolves.toBeUndefined();
  });

  it('delete also removes what an interrupted secret write of the file left', async () => {
    const removeSecretTemps = vi.fn(async () => {});
    const fs = adapter({ remove: vi.fn(async () => ({ success: true })), removeSecretTemps });
    await fs.delete('.switch/agents/a.json');
    expect(removeSecretTemps).toHaveBeenCalledWith('.switch/agents/a.json');
  });

  it('delete throws when those copies cannot be removed', async () => {
    const fs = adapter({
      remove: vi.fn(async () => ({ success: true })),
      removeSecretTemps: vi.fn(async () => {
        throw new Error('Permission denied');
      }),
    });
    await expect(fs.delete('.switch/agents/a.json')).rejects.toThrow(/Permission denied/);
  });

  it('protectSecret goes to the remote filesystem, options and all, and returns what it found', async () => {
    const protectSecret = vi.fn(async () => false);
    const fs = adapter({ protectSecret });
    expect(await fs.protectSecret('.switch/agents/a.json')).toBe(false);
    await fs.protectSecret('.claude/settings.local.json', { fileOnly: true });
    expect(protectSecret.mock.calls).toEqual([
      ['.switch/agents/a.json', undefined],
      ['.claude/settings.local.json', { fileOnly: true }],
    ]);
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

  it('a strict list answers [] for a missing directory and throws on anything else', async () => {
    const missing = adapter({
      list: vi.fn(async () => {
        throw new FileSystemError('No such file', FileSystemErrorCodes.NOT_FOUND);
      }),
    });
    expect(await missing.list('gone', { strict: true })).toEqual([]);

    const broken = adapter({
      list: vi.fn(async () => {
        throw new FileSystemError('channel open failure', FileSystemErrorCodes.CONNECTION_ERROR);
      }),
    });
    expect(await broken.list('x')).toEqual([]);
    await expect(broken.list('x', { strict: true })).rejects.toThrow(/channel open failure/);
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
