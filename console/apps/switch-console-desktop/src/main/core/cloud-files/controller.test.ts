import { beforeEach, describe, expect, it, vi } from 'vitest';
import { allFeatureFlagsOff } from '@shared/core/feature-flags/feature-flags';

// The cloud-files RPCs: none of Core's routes is called unless a good flags read
// has both hosted_v2 and hosted_cloud_files on, and a preview never fetches
// bytes for a type that isn't shown.

const current = vi.hoisted(() => vi.fn());
const listCloudFiles = vi.hoisted(() => vi.fn());
const readCloudFile = vi.hoisted(() => vi.fn());
vi.mock('electron', () => ({ dialog: { showSaveDialog: vi.fn() } }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/core/feature-flags/feature-flags', () => ({ featureFlagsService: { current } }));
vi.mock('@main/core/workspaces/workspace-session', () => ({
  withReachableServerWorkspaceSession: async (_id: string, fn: (s: unknown) => unknown) =>
    fn({ id: 'srv-1' }),
}));
vi.mock('./gateway', () => ({
  listCloudFiles,
  readCloudFile,
  readCloudFileChunks: vi.fn(),
  openCloudZip: vi.fn(),
}));

const { cloudFilesController } = await import('./controller');

const flags = (over: {
  v2?: boolean;
  files?: boolean;
  fetchedAt?: number | null;
  error?: string | null;
}) => ({
  serverId: 'srv-1',
  flags: {
    ...allFeatureFlagsOff(),
    hosted_v2: over.v2 ?? true,
    hosted_cloud_files: over.files ?? true,
  },
  fetchedAt: over.fetchedAt === undefined ? 1 : over.fetchedAt,
  error: over.error ?? null,
});

beforeEach(() => {
  vi.clearAllMocks();
  listCloudFiles.mockResolvedValue({ entries: [] });
});

describe('the gate', () => {
  it.each([
    ['hosted_v2 off', flags({ v2: false })],
    ['hosted_cloud_files off', flags({ files: false })],
    [
      'a failed read (every flag off)',
      flags({ v2: false, files: false, fetchedAt: null, error: 'down' }),
    ],
    ['a failed read after a good one', flags({ error: 'down' })],
    ['never read', flags({ fetchedAt: null })],
  ])('%s: no route is called', async (_label, state) => {
    current.mockResolvedValue(state);
    expect(await cloudFilesController.list({ serverId: 'srv-1', path: '' })).toEqual({
      ok: false,
      code: 'no_files',
    });
    expect(listCloudFiles).not.toHaveBeenCalled();
  });

  it('a good read with both on lists the files', async () => {
    current.mockResolvedValue(flags({}));
    expect(await cloudFilesController.list({ serverId: 'srv-1', path: 'shared' })).toEqual({
      ok: true,
      value: { entries: [] },
    });
    expect(listCloudFiles).toHaveBeenCalledWith({ id: 'srv-1' }, 'shared', undefined);
  });
});

describe('preview', () => {
  beforeEach(() => current.mockResolvedValue(flags({})));

  it.each(['page.html', 'art.svg', 'doc.pdf'])(
    '%s is download only, and no bytes are fetched',
    async (name) => {
      expect(
        await cloudFilesController.preview({ serverId: 'srv-1', path: name, name, size: 10 })
      ).toEqual({
        ok: true,
        value: { kind: 'download', reason: 'type' },
      });
      expect(readCloudFile).not.toHaveBeenCalled();
    }
  );

  it('a png is read up to the image cap and comes back as an image', async () => {
    readCloudFile.mockResolvedValue(new Uint8Array([137, 80, 78, 71]));
    const result = await cloudFilesController.preview({
      serverId: 'srv-1',
      path: 'a.png',
      name: 'a.png',
      size: 4,
    });
    expect(result).toEqual({
      ok: true,
      value: { kind: 'image', mimeType: 'image/png', data: 'iVBORw==' },
    });
    expect(readCloudFile).toHaveBeenCalledWith({ id: 'srv-1' }, 'a.png', 10 * 1024 * 1024);
  });

  it('a .txt that is really binary is download only', async () => {
    readCloudFile.mockResolvedValue(new Uint8Array([1, 0, 2]));
    expect(
      await cloudFilesController.preview({
        serverId: 'srv-1',
        path: 'x.txt',
        name: 'x.txt',
        size: 3,
      })
    ).toEqual({ ok: true, value: { kind: 'download', reason: 'type' } });
  });

  it('a file over its preview size is too large, and no bytes are fetched', async () => {
    expect(
      await cloudFilesController.preview({
        serverId: 'srv-1',
        path: 'big.mp4',
        name: 'big.mp4',
        size: 25 * 1024 * 1024 + 1,
      })
    ).toEqual({ ok: true, value: { kind: 'download', reason: 'too_large' } });
    expect(readCloudFile).not.toHaveBeenCalled();
  });

  it('an mp4 whose bytes really are mp4 comes back as video, read up to the 25 MB cap', async () => {
    const bytes = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
    readCloudFile.mockResolvedValue(bytes);
    expect(
      await cloudFilesController.preview({
        serverId: 'srv-1',
        path: 'c.mp4',
        name: 'c.mp4',
        size: 12,
      })
    ).toEqual({
      ok: true,
      value: { kind: 'video', mimeType: 'video/mp4', data: Buffer.from(bytes).toString('base64') },
    });
    expect(readCloudFile).toHaveBeenCalledWith({ id: 'srv-1' }, 'c.mp4', 25 * 1024 * 1024);
  });

  it('a .webm that is really HTML is download only, never a video', async () => {
    readCloudFile.mockResolvedValue(new TextEncoder().encode('<html><script>x</script>'));
    expect(
      await cloudFilesController.preview({
        serverId: 'srv-1',
        path: 'v.webm',
        name: 'v.webm',
        size: 24,
      })
    ).toEqual({ ok: true, value: { kind: 'download', reason: 'type' } });
  });

  it('code, CSV and JSON come back as text with what the renderer needs', async () => {
    const ask = (name: string, text: string) => {
      readCloudFile.mockResolvedValue(new TextEncoder().encode(text));
      return cloudFilesController.preview({
        serverId: 'srv-1',
        path: name,
        name,
        size: text.length,
      });
    };
    expect(await ask('a.py', 'x = 1')).toEqual({
      ok: true,
      value: { kind: 'code', text: 'x = 1', language: 'python' },
    });
    expect(await ask('m.csv', 'a,b')).toEqual({
      ok: true,
      value: { kind: 'csv', text: 'a,b', delimiter: ',' },
    });
    expect(await ask('d.json', '{}')).toEqual({ ok: true, value: { kind: 'json', text: '{}' } });
  });

  it('Markdown comes back as text, for the renderer to show without HTML', async () => {
    readCloudFile.mockResolvedValue(new TextEncoder().encode('# Hi <script>x</script>'));
    expect(
      await cloudFilesController.preview({
        serverId: 'srv-1',
        path: 'r.md',
        name: 'r.md',
        size: 23,
      })
    ).toEqual({ ok: true, value: { kind: 'markdown', text: '# Hi <script>x</script>' } });
  });
});
