import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  execFile: vi.fn(
    (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null) => void
    ) => callback(null)
  ),
  warn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('@main/lib/logger', () => ({ log: { warn: h.warn } }));

import { restrictWindowsDirectoryToOwner, restrictWindowsFileToOwner } from './windows-owner-acl';

describe('Windows owner-only ACLs', () => {
  const previousUser = process.env.USERNAME;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.USERNAME = 'alice';
  });

  afterEach(() => {
    if (previousUser === undefined) delete process.env.USERNAME;
    else process.env.USERNAME = previousUser;
  });

  it('replaces a file’s inherited ACL with full control for the current user alone', async () => {
    await restrictWindowsFileToOwner('C:\\work\\.switch\\agents\\a.json');

    expect(h.execFile.mock.calls[0]?.slice(0, 2)).toEqual([
      'icacls',
      ['C:\\work\\.switch\\agents\\a.json', '/inheritance:r', '/grant:r', 'alice:F'],
    ]);
  });

  it('makes a directory’s grant inheritable, so the files in it are restricted too', async () => {
    await restrictWindowsDirectoryToOwner('C:\\work\\.switch\\agents');

    expect(h.execFile.mock.calls[0]?.slice(0, 2)).toEqual([
      'icacls',
      ['C:\\work\\.switch\\agents', '/inheritance:r', '/grant:r', 'alice:(OI)(CI)F'],
    ]);
  });

  it('warns and leaves the path alone when it cannot tell who the user is', async () => {
    delete process.env.USERNAME;

    await restrictWindowsFileToOwner('C:\\work\\a.json');

    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('USERNAME unset'), {
      path: 'C:\\work\\a.json',
    });
  });

  it('warns rather than throws when icacls fails', async () => {
    h.execFile.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(new Error('Access is denied.'))
    );

    await expect(restrictWindowsDirectoryToOwner('C:\\work')).resolves.toBeUndefined();

    expect(h.warn).toHaveBeenCalledWith(expect.stringContaining('could not restrict'), {
      path: 'C:\\work',
      error: 'Access is denied.',
    });
  });
});
