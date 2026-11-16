import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildFromTemplate = vi.hoisted(() =>
  vi.fn((template: Electron.MenuItemConstructorOptions[]) => template)
);

vi.mock('electron', () => ({
  app: { setAboutPanelOptions: vi.fn(), getVersion: () => '0.0.0' },
  clipboard: { writeText: vi.fn() },
  Menu: { buildFromTemplate, setApplicationMenu: vi.fn() },
  shell: { openExternal: vi.fn() },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./select-all', () => ({ selectAll: vi.fn() }));
vi.mock('./window', () => ({ getMainWindow: vi.fn() }));

/** The roles in the View menu the app would build. */
async function viewMenuRoles(devtoolsEnabled: boolean): Promise<unknown[]> {
  vi.resetModules();
  vi.doMock('./devtools', () => ({ DEVTOOLS_ENABLED: devtoolsEnabled }));
  const { setupApplicationMenu } = await import('./menu');
  setupApplicationMenu();
  const template = buildFromTemplate.mock.lastCall![0];
  const view = template.find((item) => item.label === 'View');
  return (view!.submenu as Electron.MenuItemConstructorOptions[]).map((item) => item.role);
}

beforeEach(() => {
  buildFromTemplate.mockClear();
});

describe('setupApplicationMenu', () => {
  it('offers no DevTools, and so no shortcut to them, in a stable build', async () => {
    expect(await viewMenuRoles(false)).not.toContain('toggleDevTools');
  });

  it('keeps DevTools in dev and Canary builds', async () => {
    expect(await viewMenuRoles(true)).toContain('toggleDevTools');
  });
});
