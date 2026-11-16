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
  writeFile: vi.fn(async () => {}),
  warn: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('node:fs/promises', () => ({ writeFile: h.writeFile }));
vi.mock('@main/lib/logger', () => ({ log: { warn: h.warn } }));

import { markDownloaded } from './download-quarantine';

const realPlatform = process.platform;
function onPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('markDownloaded', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => onPlatform(realPlatform));

  it('writes the quarantine record a browser writes on macOS', async () => {
    onPlatform('darwin');
    vi.useFakeTimers({ now: new Date('2026-11-16T12:00:00Z'), toFake: ['Date'] });
    try {
      await markDownloaded('/Users/me/Downloads/invoice_fdp.exe');
    } finally {
      vi.useRealTimers();
    }

    const [command, args] = h.execFile.mock.calls[0] ?? [];
    expect(command).toBe('/usr/bin/xattr');
    expect(args?.slice(0, 2)).toEqual(['-w', 'com.apple.quarantine']);
    expect(args?.[3]).toBe('/Users/me/Downloads/invoice_fdp.exe');
    const seconds = Math.floor(Date.parse('2026-11-16T12:00:00Z') / 1000).toString(16);
    expect(args?.[2]).toMatch(
      new RegExp(
        `^0081;${seconds};Switch Console( Canary)?;[0-9A-F]{8}(-[0-9A-F]{4}){3}-[0-9A-F]{12}$`
      )
    );
    expect(h.warn).not.toHaveBeenCalled();
  });

  it('logs a warning when macOS refuses the record, and does not throw', async () => {
    onPlatform('darwin');
    h.execFile.mockImplementationOnce((_command, _args, _options, callback) =>
      callback(new Error('xattr: [Errno 1] Operation not permitted'))
    );

    await expect(markDownloaded('/Volumes/share/report.html')).resolves.toBeUndefined();

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not mark a saved attachment as downloaded'),
      expect.objectContaining({
        event: 'download_mark_failed',
        platform: 'darwin',
        path: '/Volumes/share/report.html',
        error: expect.stringContaining('Operation not permitted'),
      })
    );
  });

  it('writes the Internet zone to the file’s Zone.Identifier stream on Windows', async () => {
    onPlatform('win32');

    await markDownloaded('C:\\Users\\me\\Downloads\\invoice_fdp.exe');

    expect(h.writeFile).toHaveBeenCalledWith(
      'C:\\Users\\me\\Downloads\\invoice_fdp.exe:Zone.Identifier',
      '[ZoneTransfer]\r\nZoneId=3\r\n'
    );
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it('logs a warning when the Windows volume has no streams', async () => {
    onPlatform('win32');
    h.writeFile.mockRejectedValueOnce(new Error('EINVAL: invalid argument'));

    await markDownloaded('E:\\invoice_fdp.exe');

    expect(h.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ platform: 'win32', error: expect.stringContaining('EINVAL') })
    );
  });

  it('leaves the file alone on Linux, which has no such mark', async () => {
    onPlatform('linux');

    await markDownloaded('/home/me/Downloads/invoice_fdp.exe');

    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.warn).not.toHaveBeenCalled();
  });
});
