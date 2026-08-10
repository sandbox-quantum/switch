import { describe, expect, it, vi } from 'vitest';
import {
  FileSystemError,
  FileSystemErrorCodes,
  type FileSystemProvider,
} from '@main/core/fs/types';
import { createRemotePluginFs } from './remote-plugin-fs';

function adapter(stub: Partial<FileSystemProvider>) {
  return createRemotePluginFs(stub as unknown as FileSystemProvider);
}

describe('createRemotePluginFs (agent runtime)', () => {
  it('read returns the file content', async () => {
    const read = vi.fn(async () => ({ content: 'hello', truncated: false, totalSize: 5 }));
    const fs = adapter({ read });
    expect(await fs.read('.claude/settings.local.json')).toBe('hello');
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
    await expect(fs.read('.claude/settings.local.json')).rejects.toThrow(/channel open failure/);
  });

  it('read propagates untyped failures (e.g. a dropped SSH connection)', async () => {
    const fs = adapter({
      read: vi.fn(async () => {
        throw new Error('SSH connection is not available');
      }),
    });
    await expect(fs.read('.claude/settings.local.json')).rejects.toThrow(
      /SSH connection is not available/
    );
  });

  it('write creates the parent directory and fails loud on an unsuccessful write', async () => {
    const mkdir = vi.fn(async () => {});
    const write = vi.fn(async () => ({ success: true, bytesWritten: 1 }));
    const fs = adapter({ mkdir, write });
    await fs.write('.claude/settings.local.json', '{}');
    expect(mkdir).toHaveBeenCalledWith('.claude', { recursive: true });
    expect(write).toHaveBeenCalledWith('.claude/settings.local.json', '{}');

    const failing = adapter({
      mkdir,
      write: vi.fn(async () => ({ success: false, bytesWritten: 0, error: 'disk full' })),
    });
    await expect(failing.write('a', 'b')).rejects.toThrow(/disk full/);
  });
});
