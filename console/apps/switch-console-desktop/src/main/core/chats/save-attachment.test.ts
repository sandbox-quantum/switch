import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  showSaveDialog: vi.fn(),
  getMainWindow: vi.fn<() => object | null>(() => ({})),
  writeFile: vi.fn(async () => {}),
  markDownloaded: vi.fn(async () => {}),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/Users/me/Downloads' },
  dialog: { showSaveDialog: h.showSaveDialog },
}));
vi.mock('@main/app/window', () => ({ getMainWindow: h.getMainWindow }));
vi.mock('node:fs/promises', () => ({ writeFile: h.writeFile }));
vi.mock('@main/core/fs/download-quarantine', () => ({ markDownloaded: h.markDownloaded }));

import { saveChatAttachment } from './save-attachment';

const bytes = new Uint8Array([0x3c, 0x68, 0x31, 0x3e]);

describe('saveChatAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.getMainWindow.mockReturnValue({});
  });

  it('suggests the name the chat shows, with the real extension', async () => {
    h.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await saveChatAttachment('invoice\u202Efdp.exe', async () => bytes);

    expect(h.showSaveDialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ defaultPath: join('/Users/me/Downloads', 'invoice_fdp.exe') })
    );
  });

  it('writes the bytes where the person chose, then marks the file as downloaded', async () => {
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/report.html' });

    await expect(saveChatAttachment('report.html', async () => bytes)).resolves.toBe(
      '/tmp/report.html'
    );

    expect(h.writeFile).toHaveBeenCalledWith('/tmp/report.html', bytes);
    expect(h.markDownloaded).toHaveBeenCalledWith('/tmp/report.html');
    expect(h.writeFile.mock.invocationCallOrder[0]).toBeLessThan(
      h.markDownloaded.mock.invocationCallOrder[0]!
    );
  });

  it('downloads nothing when the person cancels', async () => {
    h.showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const read = vi.fn(async () => bytes);

    await expect(saveChatAttachment('report.html', read)).resolves.toBeNull();

    expect(read).not.toHaveBeenCalled();
    expect(h.writeFile).not.toHaveBeenCalled();
    expect(h.markDownloaded).not.toHaveBeenCalled();
  });

  it('writes nothing when the download fails, and says why', async () => {
    h.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/report.html' });

    await expect(
      saveChatAttachment('report.html', async () => {
        throw new Error('Switch gateway returned 404: not in this room');
      })
    ).rejects.toThrow('not in this room');

    expect(h.writeFile).not.toHaveBeenCalled();
  });

  it('refuses rather than pretending to cancel when there is no window to ask in', async () => {
    h.getMainWindow.mockReturnValue(null);

    await expect(saveChatAttachment('report.html', async () => bytes)).rejects.toThrow('no window');
    expect(h.showSaveDialog).not.toHaveBeenCalled();
  });
});
