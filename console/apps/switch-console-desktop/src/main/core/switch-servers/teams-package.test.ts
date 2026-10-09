import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const showSaveDialog = vi.hoisted(() => vi.fn());
const getMainWindow = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const fetchTeamsPackage = vi.hoisted(() => vi.fn());

vi.mock('electron', () => ({
  dialog: { showSaveDialog },
}));
vi.mock('@main/app/window', () => ({ getMainWindow }));
vi.mock('node:fs/promises', () => ({ writeFile }));
vi.mock('@main/core/switch-servers/gateway-client', () => ({ fetchTeamsPackage }));

const { saveTeamsPackage } = await import('./teams-package');

const SERVER = {
  id: 'srv-1',
  name: 'S',
  url: 'https://switch.example.com',
  managed: false,
} as never;

const WINDOW = {} as never;

describe('saveTeamsPackage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getMainWindow.mockReturnValue(WINDOW);
    writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the save dialog before fetching the package, so cancelling costs no round trip', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });

    await expect(saveTeamsPackage(SERVER, 'b1', 'switch-teams-acme.zip')).resolves.toBeNull();

    expect(showSaveDialog).toHaveBeenCalledWith(
      WINDOW,
      expect.objectContaining({ defaultPath: 'switch-teams-acme.zip' })
    );
    expect(fetchTeamsPackage).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('returns null without opening a dialog when there is no window to own it', async () => {
    getMainWindow.mockReturnValue(null);

    await expect(saveTeamsPackage(SERVER, 'b1', 'switch-teams-acme.zip')).resolves.toBeNull();

    expect(showSaveDialog).not.toHaveBeenCalled();
  });

  it('returns null when the dialog resolves with no path, even if not formally cancelled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: undefined });

    await expect(saveTeamsPackage(SERVER, 'b1', 'switch-teams-acme.zip')).resolves.toBeNull();

    expect(fetchTeamsPackage).not.toHaveBeenCalled();
  });

  it('fetches the package and writes it to the chosen path on save', async () => {
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/switch-teams-acme.zip' });
    const bytes = new TextEncoder().encode('zip-bytes').buffer;
    fetchTeamsPackage.mockResolvedValue(bytes);

    await expect(saveTeamsPackage(SERVER, 'b1', 'switch-teams-acme.zip')).resolves.toBe(
      '/tmp/switch-teams-acme.zip'
    );

    expect(fetchTeamsPackage).toHaveBeenCalledWith(SERVER, 'b1');
    expect(writeFile).toHaveBeenCalledWith('/tmp/switch-teams-acme.zip', Buffer.from(bytes));
  });
});
