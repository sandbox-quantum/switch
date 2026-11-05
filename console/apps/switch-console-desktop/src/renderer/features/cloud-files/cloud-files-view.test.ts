// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allFeatureFlagsOff,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';

// Your cloud files as drawn: the agent's folder opened by View files, the
// resting box with Wake it, an image preview in a Blob typed by
// attachmentBlobType, and nothing called when the view isn't shown.

const flagsState = new Map<string, ServerFeatureFlags>();
const list = vi.fn();
const preview = vi.fn();
const params = vi.hoisted(() => ({
  value: { serverId: 's1' } as { serverId: string; agent?: string; path?: string },
}));
const navigate = vi.hoisted(() => vi.fn());
const createObjectURL = vi.fn((_blob: Blob) => 'blob:preview');

vi.mock('@renderer/lib/ipc', () => ({
  events: { on: () => () => {} },
  rpc: {
    featureFlags: {
      get: async (serverId: string) => ({ success: true, data: flagsState.get(serverId) }),
      refresh: vi.fn(async () => ({ success: true, data: undefined })),
    },
    cloudFiles: {
      list: (...args: unknown[]) => list(...args),
      preview: (...args: unknown[]) => preview(...args),
      saveFile: vi.fn(),
      saveZip: vi.fn(),
    },
    switchServers: { ensureCloudMachine: vi.fn() },
  },
}));
vi.mock('@renderer/features/cloud-agents/use-cloud-agents', () => ({
  useCloudMachines: () => ({ data: [{ backend: 'box', agents: ['a1'], controller_id: 'c1' }] }),
}));
vi.mock('@renderer/features/managed-agents/use-managed-agents', () => ({
  MANAGED_AGENTS_KEY: 'managed-agents',
}));
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useParams: () => ({ params: params.value }),
  useNavigate: () => ({ navigate }),
}));
vi.mock('@renderer/features/switch-servers/server-section-titlebar', () => ({
  ServerSectionTitlebar: () => null,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

const { cloudFilesView, openablePath } = await import('./cloud-files-view');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
URL.createObjectURL = createObjectURL as never;
URL.revokeObjectURL = vi.fn();

const on = (serverId: string, files = true): ServerFeatureFlags => ({
  serverId,
  flags: { ...allFeatureFlagsOff(), hosted_v2: true, hosted_cloud_files: files },
  fetchedAt: 1,
  error: null,
});
const folder = (name: string, over: object = {}) => ({
  name,
  kind: 'folder',
  size: 0,
  mtime: 1,
  ...over,
});
const file = (name: string, size = 10) => ({ name, kind: 'file', size, mtime: 1 });
const TOP = [
  folder('web-frontend', { label: 'Web Frontend', agent: 'web-frontend' }),
  folder('baker', { label: 'Baker', agent: 'baker' }),
  folder('shared', { label: 'Shared' }),
];

async function open() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(cloudFilesView.MainPanel)));
  return { host, done: () => act(() => root.unmount()) };
}
const text = (host: HTMLElement) => host.textContent ?? '';
const click = async (element: Element | null | undefined) => {
  if (!element) throw new Error('nothing to click');
  await act(async () => (element as HTMLElement).click());
};
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

afterEach(() => {
  vi.clearAllMocks();
  document.body.innerHTML = '';
  params.value = { serverId: 's1' };
});

describe('Your cloud files', () => {
  it('View files opens the agent’s own folder, matched on its name, not its label', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', agent: 'web-frontend' };
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: TOP } }
        : {
            ok: true,
            value: {
              entries: [
                folder('dist'),
                folder('node_modules', { collapsed: true }),
                file('README.md'),
              ],
            },
          }
    );
    const view = await open();
    expect(list).toHaveBeenCalledWith({ serverId: 's1', path: 'web-frontend' });
    expect(text(view.host)).toContain('README.md');
    expect(text(view.host)).toContain('Large folder');
    view.done();
  });

  it('a path param opens that folder first, ahead of the agent', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', agent: 'web-frontend', path: 'shared/sample-bakery' };
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === '' ? { ok: true, value: { entries: TOP } } : { ok: true, value: { entries: [] } }
    );
    const view = await open();
    expect(list).toHaveBeenCalledWith({ serverId: 's1', path: 'shared/sample-bakery' });
    expect(list).not.toHaveBeenCalledWith({ serverId: 's1', path: 'web-frontend' });
    view.done();
  });

  it('with no agent folder to match, it opens the top level: agents first, then Shared', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', agent: 'gone' };
    list.mockResolvedValue({ ok: true, value: { entries: TOP } });
    const view = await open();
    const names = [...view.host.querySelectorAll('tbody tr td:first-child')].map((cell) =>
      cell.textContent?.trim()
    );
    expect(names).toEqual(['Baker', 'Web Frontend', 'Shared']);
    view.done();
  });

  it('a large folder asks before opening', async () => {
    flagsState.set('s1', on('s1'));
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: [folder('node_modules', { collapsed: true })] } }
        : { ok: true, value: { entries: [] } }
    );
    const view = await open();
    await click([...view.host.querySelectorAll('tbody button')][0]);
    expect(text(view.host)).toContain('Large folder. Open anyway?');
    expect(list).not.toHaveBeenCalledWith({ serverId: 's1', path: 'node_modules' });
    await click(button(view.host, 'Open'));
    expect(list).toHaveBeenCalledWith({ serverId: 's1', path: 'node_modules' });
    view.done();
  });

  it('a resting box offers Wake it, and calls nothing more until asked', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: false, code: 'box_resting' });
    const view = await open();
    expect(text(view.host)).toContain('Your cloud is resting');
    expect(button(view.host, 'Wake it')).toBeDefined();
    expect(list).toHaveBeenCalledTimes(1);
    view.done();
  });

  it('an image preview is a Blob typed by attachmentBlobType', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('logo.png', 4)] } });
    preview.mockResolvedValue({
      ok: true,
      value: { kind: 'image', mimeType: 'image/png', data: 'iVBORw==' },
    });
    const view = await open();
    await click([...view.host.querySelectorAll('tbody button')][0]);
    expect(preview).toHaveBeenCalledWith({
      serverId: 's1',
      path: 'logo.png',
      name: 'logo.png',
      size: 4,
    });
    expect(createObjectURL.mock.calls[0]![0].type).toBe('image/png');
    expect(view.host.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
    view.done();
  });

  it('even if an image preview arrived typed as HTML, the Blob is bytes only', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('logo.png', 4)] } });
    preview.mockResolvedValue({
      ok: true,
      value: { kind: 'image', mimeType: 'text/html', data: 'PGI+' },
    });
    const view = await open();
    await click([...view.host.querySelectorAll('tbody button')][0]);
    expect(createObjectURL.mock.calls[0]![0].type).toBe('application/octet-stream');
    view.done();
  });

  it('a type that isn’t previewed is offered for download only', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('page.html')] } });
    preview.mockResolvedValue({ ok: true, value: { kind: 'download' } });
    const view = await open();
    await click([...view.host.querySelectorAll('tbody button')][0]);
    expect(text(view.host)).toContain('no preview for this kind of file');
    expect(button(view.host, 'Download')).toBeDefined();
    expect(view.host.querySelector('iframe, img, object, embed')).toBeNull();
    view.done();
  });

  it('the zip button says all at the top level and folder inside one', async () => {
    flagsState.set('s1', on('s1'));
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === '' ? { ok: true, value: { entries: TOP } } : { ok: true, value: { entries: [] } }
    );
    const view = await open();
    expect(button(view.host, 'Download all as zip')).toBeDefined();
    await click(button(view.host, 'Shared'));
    expect(button(view.host, 'Download folder as zip')).toBeDefined();
    expect(button(view.host, 'Download all as zip')).toBeUndefined();
    view.done();
  });

  it('a folder’s size is a dash, and a change shows how long ago with the full date on hover', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [folder('menus'), file('menu.csv')] } });
    const view = await open();
    const rows = [...view.host.querySelectorAll('tbody tr')].map((row) => [
      ...row.querySelectorAll('td'),
    ]);
    expect(rows[0]![1]!.textContent).toBe('—');
    expect(rows[1]![1]!.textContent).toBe('10 B');
    expect(rows[1]![2]!.getAttribute('title')).toMatch(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} [AP]M$/);
    view.done();
  });

  it('a preview keeps the path, ending in the file, and a folder in it goes back there', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared/sample-bakery' };
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: TOP } }
        : { ok: true, value: { entries: [file('README.md')] } }
    );
    preview.mockResolvedValue({ ok: true, value: { kind: 'markdown', text: '# Hello' } });
    const view = await open();
    await click(button(view.host, 'README.md'));
    const crumbs = view.host.querySelector('section nav[aria-label="Folder path"]');
    expect(crumbs?.textContent).toBe('All filesSharedsample-bakeryREADME.md');
    expect(crumbs?.querySelector('[aria-current="page"]')?.textContent).toBe('README.md');
    await click(
      [...(crumbs?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'sample-bakery')
    );
    expect(view.host.querySelector('[aria-label="Close preview"]')).toBeNull();
    expect(button(view.host, 'README.md')).toBeDefined();
    view.done();
  });

  it('with hosted_cloud_files off, nothing is listed and it points to Your Agents', async () => {
    flagsState.set('s1', on('s1', false));
    const view = await open();
    expect(list).not.toHaveBeenCalled();
    expect(text(view.host)).toContain('once you have an agent in your cloud');
    view.done();
  });
});

describe('openablePath', () => {
  it('opens plain names only', () => {
    expect(openablePath('shared/sample-bakery')).toBe('shared/sample-bakery');
    for (const bad of ['', '/etc', 'a/../b', './a', 'a//b', 'a/', 7, undefined, 'a\0b'])
      expect(openablePath(bad)).toBeNull();
  });
});
