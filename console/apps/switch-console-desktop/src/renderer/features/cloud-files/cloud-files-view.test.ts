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
const ensureCloudMachine = vi.fn(async (_serverId: string) => {});
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
    switchServers: {
      ensureCloudMachine: (serverId: string) => ensureCloudMachine(serverId),
    },
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
/** The preview modal, which opens in a portal on the page, not inside the view. */
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const press = async (key: string, target: Element | null = dialog()) => {
  if (!target) throw new Error('nothing to press on');
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  });
};
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
    // The PM's resting line, the same everywhere in both apps.
    expect(text(view.host)).toContain(
      'Your cloud is resting to save resources. It wakes in about a minute when you message an agent or press Wake it.'
    );
    expect(text(view.host)).not.toContain('counts as awake time');
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
    expect(dialog()?.querySelector('img')?.getAttribute('src')).toBe('blob:preview');
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
    expect(text(dialog()!)).toContain('can’t be previewed here');
    expect(button(dialog()!, 'Download')).toBeDefined();
    expect(document.querySelector('iframe, img, object, embed, video')).toBeNull();
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
    const crumbs = dialog()?.querySelector('nav[aria-label="Folder path"]');
    expect(crumbs?.textContent).toBe('All filesSharedsample-bakeryREADME.md');
    expect(crumbs?.querySelector('[aria-current="page"]')?.textContent).toBe('README.md');
    await click(
      [...(crumbs?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'sample-bakery')
    );
    expect(dialog()).toBeNull();
    expect(document.querySelector('[aria-label="Close preview"]')).toBeNull();
    expect(button(view.host, 'README.md')).toBeDefined();
    view.done();
  });

  it('a file opens in a modal over the list, and Esc closes it with the list unchanged', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [folder('src'), file('a.txt')] } });
    preview.mockResolvedValue({ ok: true, value: { kind: 'text', text: 'hello' } });
    const view = await open();
    await click(button(view.host, 'a.txt'));
    expect(dialog()?.getAttribute('aria-labelledby')).toBeTruthy();
    expect(text(dialog()!)).toContain('hello');
    expect(button(view.host, 'a.txt')).toBeDefined(); // the list is still there underneath
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(button(view.host, 'src')).toBeDefined();
    view.done();
  });

  it('previous and next step through files only, stop at the ends, and fetch only the file shown', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({
      ok: true,
      value: { entries: [file('a.txt'), folder('src'), file('b.txt'), file('c.txt')] },
    });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: true,
      value: { kind: 'text', text: `inside ${name}` },
    }));
    const view = await open();
    await click(button(view.host, 'a.txt'));
    const previous = () =>
      dialog()?.querySelector<HTMLButtonElement>('[aria-label="Previous file"]');
    const next = () => dialog()?.querySelector<HTMLButtonElement>('[aria-label="Next file"]');
    expect(previous()?.disabled).toBe(true);
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('inside b.txt');
    await click(next());
    expect(text(dialog()!)).toContain('inside c.txt');
    expect(next()?.disabled).toBe(true);
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('inside c.txt');
    await press('ArrowLeft');
    expect(text(dialog()!)).toContain('inside b.txt');
    expect(preview.mock.calls.map(([call]) => (call as { name: string }).name)).toEqual([
      'a.txt',
      'b.txt',
      'c.txt',
      'b.txt',
    ]);
    view.done();
  });

  it('a video plays from a Blob typed by the main process’s check, muted and not autoplaying', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('clip.mp4'), file('notes.txt')] } });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: true,
      value:
        name === 'clip.mp4'
          ? { kind: 'video', mimeType: 'video/mp4', data: 'AAAAGGZ0eXA=' }
          : { kind: 'text', text: 'not the video' },
    }));
    const view = await open();
    await click(button(view.host, 'clip.mp4'));
    expect(createObjectURL.mock.calls[0]![0].type).toBe('video/mp4');
    const video = dialog()?.querySelector('video');
    expect(video?.getAttribute('src')).toBe('blob:preview');
    expect(video?.hasAttribute('controls')).toBe(true);
    expect(video?.muted).toBe(true);
    expect(video?.autoplay).toBe(false);
    expect(video?.getAttribute('preload')).toBe('metadata');
    expect(video?.querySelector('track')).toBeNull();
    // Arrow keys belong to the video while it has focus.
    await press('ArrowRight', video!);
    expect(dialog()?.querySelector('video')).not.toBeNull();
    expect(preview).toHaveBeenCalledTimes(1);
    await press('Escape');
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:preview');
    view.done();
  });

  it('closing gives focus back to the last file shown in the list', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('a.txt'), file('b.txt')] } });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: true,
      value: { kind: 'text', text: `inside ${name}` },
    }));
    const view = await open();
    await click(button(view.host, 'a.txt'));
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('inside b.txt');
    await press('Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement?.getAttribute('data-cloud-file')).toBe('b.txt');
    view.done();
  });

  it('a video answer with any other type is never played', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('clip.mp4')] } });
    preview.mockResolvedValue({
      ok: true,
      value: { kind: 'video', mimeType: 'text/html', data: 'PGI+' },
    });
    const view = await open();
    await click(button(view.host, 'clip.mp4'));
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('video')).toBeNull();
    expect(text(dialog()!)).toContain('can’t be previewed here');
    view.done();
  });

  it('closing, or moving on, before a preview arrives never shows or keeps the late answer', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('a.mp4'), file('b.txt')] } });
    let answerA: (value: unknown) => void = () => {};
    preview.mockImplementation(({ name }: { name: string }) =>
      name === 'a.mp4'
        ? new Promise((resolve) => (answerA = resolve))
        : Promise.resolve({ ok: true, value: { kind: 'text', text: 'inside b' } })
    );
    const view = await open();
    await click(button(view.host, 'a.mp4'));
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('inside b');
    await act(async () =>
      answerA({ ok: true, value: { kind: 'video', mimeType: 'video/mp4', data: 'AAAAGGZ0eXA=' } })
    );
    expect(text(dialog()!)).toContain('inside b');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(dialog()?.querySelector('video')).toBeNull();
    view.done();
  });

  it('a file deleted while open, or a box gone to rest, gives fixed words, not a spinner', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('gone.txt'), file('sleep.txt')] } });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: false,
      code: name === 'gone.txt' ? 'not_found' : 'box_resting',
    }));
    const view = await open();
    await click(button(view.host, 'gone.txt'));
    expect(text(dialog()!)).toContain('This file isn’t there any more.');
    expect(button(dialog()!, 'Download')).toBeUndefined();
    expect(dialog()?.querySelector<HTMLButtonElement>('[aria-label="Next file"]')?.disabled).toBe(
      false
    );
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('Your cloud is resting.');
    expect(button(dialog()!, 'Wake it')).toBeDefined();
    expect(button(dialog()!, 'Download')).toBeDefined();
    expect(text(dialog()!)).not.toContain('Loading the preview');
    view.done();
  });

  it('Wake it wakes the box once and reads the same file again until it’s up', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      flagsState.set('s1', on('s1'));
      list.mockResolvedValue({ ok: true, value: { entries: [file('menu.txt')] } });
      let up = false;
      preview.mockImplementation(async () =>
        up
          ? { ok: true, value: { kind: 'text', text: 'rye 3' } }
          : { ok: false, code: 'box_resting' }
      );
      const view = await open();
      await click(button(view.host, 'menu.txt'));
      await click(button(dialog()!, 'Wake it'));
      expect(text(dialog()!)).toContain('Waking your cloud');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(text(dialog()!)).toContain('Waking your cloud');
      up = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_500);
      });
      expect(text(dialog()!)).toContain('rye 3');
      expect(ensureCloudMachine).toHaveBeenCalledTimes(1);
      expect(new Set(preview.mock.calls.map(([call]) => (call as { name: string }).name))).toEqual(
        new Set(['menu.txt'])
      );
      view.done();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the toggles say what they do: Show source and Show formatted, and Wrap lines shows on or off', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('a.py'), file('r.md')] } });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: true,
      value:
        name === 'a.py'
          ? { kind: 'code', text: 'x = 1', language: 'python' }
          : { kind: 'markdown', text: '# Hi' },
    }));
    const view = await open();
    await click(button(view.host, 'a.py'));
    expect(button(dialog()!, 'Wrap lines')?.getAttribute('aria-pressed')).toBe('false');
    await click(button(dialog()!, 'Wrap lines'));
    expect(button(dialog()!, 'Wrap lines')?.getAttribute('aria-pressed')).toBe('true');
    await press('ArrowRight');
    await click(button(dialog()!, 'Show source'));
    expect(button(dialog()!, 'Show formatted')).toBeDefined();
    expect(text(dialog()!)).toContain('# Hi');
    await click(button(dialog()!, 'Show formatted'));
    expect(button(dialog()!, 'Show source')).toBeDefined();
    view.done();
  });

  it('too large says so, and offers Download', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: [file('huge.mp4')] } });
    preview.mockResolvedValue({ ok: true, value: { kind: 'download', reason: 'too_large' } });
    const view = await open();
    await click(button(view.host, 'huge.mp4'));
    expect(text(dialog()!)).toContain('too large to preview');
    expect(button(dialog()!, 'Download')).toBeDefined();
    view.done();
  });

  it('code, JSON and CSV get their own views, as text only', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({
      ok: true,
      value: { entries: [file('a.py'), file('bad.json'), file('menu.csv')] },
    });
    preview.mockImplementation(async ({ name }: { name: string }) => ({
      ok: true,
      value:
        name === 'a.py'
          ? { kind: 'code', text: 'x = "<img src=x onerror=alert(1)>"', language: 'python' }
          : name === 'bad.json'
            ? { kind: 'json', text: '{nope' }
            : { kind: 'csv', text: 'item,price\nrye,3.20', delimiter: ',' },
    }));
    const view = await open();
    await click(button(view.host, 'a.py'));
    expect(dialog()?.querySelector('[data-code-view][data-language="python"]')).not.toBeNull();
    expect(dialog()?.querySelector('img')).toBeNull();
    expect(text(dialog()!)).toContain('<img src=x onerror=alert(1)>');
    await press('ArrowRight');
    expect(text(dialog()!)).toContain('This isn’t valid JSON.');
    await press('ArrowRight');
    expect([...(dialog()?.querySelectorAll('th') ?? [])].map((th) => th.textContent)).toEqual([
      'item',
      'price',
    ]);
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

describe('Your cloud files, easier to use (part 1)', () => {
  it('while the top level loads, it shows placeholder rows, not a spinner', async () => {
    flagsState.set('s1', on('s1'));
    list.mockReturnValue(new Promise(() => {}));
    const view = await open();
    expect(view.host.querySelector('[data-explorer-skeleton="list"]')).not.toBeNull();
    expect(view.host.querySelector('[data-explorer-skeleton="tree"]')).not.toBeNull();
    expect(text(view.host)).not.toContain('Opening your cloud files');
    view.done();
  });

  it('while a folder loads, the list shows placeholder rows', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(({ path }: { path: string }) =>
      path === '' ? Promise.resolve({ ok: true, value: { entries: TOP } }) : new Promise(() => {})
    );
    const view = await open();
    expect(view.host.querySelector('section [data-explorer-skeleton="list"]')).not.toBeNull();
    expect(text(view.host)).not.toContain('Loading…');
    view.done();
  });

  it('each row has its kind’s icon, from the name only', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    const names = [
      'README.md',
      'app.ts',
      'orders.csv',
      'logo.png',
      'demo.mp4',
      'site.zip',
      'notes.txt',
    ];
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: TOP } }
        : { ok: true, value: { entries: [folder('src'), ...names.map((name) => file(name))] } }
    );
    const view = await open();
    const kinds = [...view.host.querySelectorAll('tbody [data-file-kind]')].map((icon) =>
      icon.getAttribute('data-file-kind')
    );
    // Folders first, then files by name: app.ts, demo.mp4, logo.png, notes.txt, orders.csv, README.md, site.zip.
    expect(kinds).toEqual([
      'folder',
      'code',
      'video',
      'image',
      'other',
      'data',
      'markdown',
      'archive',
    ]);
    // Colour is never the only signal: each row's name, as read out, ends in its kind.
    const spoken = [...view.host.querySelectorAll('tbody [data-row-index]')].map((b) =>
      b.getAttribute('aria-label')
    );
    expect(spoken).toEqual([
      'src, Folder',
      'app.ts, Code file',
      'demo.mp4, Video',
      'logo.png, Image',
      'notes.txt, File',
      'orders.csv, Data file',
      'README.md, Markdown file',
      'site.zip, Archive',
    ]);
    expect(preview).not.toHaveBeenCalled();
    view.done();
  });

  it('an empty agent folder says files appear as the agent makes them; any other empty folder says it’s empty', async () => {
    flagsState.set('s1', on('s1'));
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === '' ? { ok: true, value: { entries: TOP } } : { ok: true, value: { entries: [] } }
    );
    params.value = { serverId: 's1', path: 'baker' };
    let view = await open();
    expect(text(view.host)).toContain('Nothing here yet. Files your agent makes appear here.');
    view.done();
    params.value = { serverId: 's1', path: 'shared' };
    view = await open();
    expect(text(view.host)).toContain('This folder is empty.');
    expect(text(view.host)).not.toContain('Nothing here yet');
    view.done();
  });

  it('the preview’s Copy path copies the path within Your cloud files and says "Path copied"', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared/sample-bakery' };
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: TOP } }
        : { ok: true, value: { entries: [file('menu.csv')] } }
    );
    preview.mockResolvedValue({ ok: true, value: { kind: 'text', text: 'item,price' } });
    const view = await open();
    await click(button(view.host, 'menu.csv'));
    await click(dialog()?.querySelector('[data-copy-path]'));
    expect(writeText).toHaveBeenCalledWith('shared/sample-bakery/menu.csv');
    expect(text(dialog()!)).toContain('Path copied');
    view.done();
  });
});

describe('Your cloud files, easier to use (part 2)', () => {
  const rows = (host: HTMLElement) =>
    [...host.querySelectorAll<HTMLElement>('tbody [data-row-index]')].map((b) =>
      b.textContent?.trim()
    );
  const filterBox = (host: HTMLElement) =>
    host.querySelector<HTMLInputElement>('input[aria-label="Filter this folder"]')!;
  const type = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const SHARED = [
    folder('sample-bakery', { mtime: 5 }),
    file('menu.csv'),
    { ...file('Menu-Draft.md'), mtime: 9 },
    { ...file('notes.txt'), mtime: 3 },
  ];
  const twoLevels = async ({ path }: { path: string }) =>
    path === ''
      ? { ok: true, value: { entries: TOP } }
      : path === 'shared'
        ? { ok: true, value: { entries: SHARED } }
        : { ok: true, value: { entries: [file('menu-old.csv'), file('recipes.md')] } };

  it('the filter narrows the loaded folder by name, ignoring case, and asks for nothing more', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    const view = await open();
    const calls = list.mock.calls.length;
    await type(filterBox(view.host), 'MENU');
    expect(rows(view.host)).toEqual(['Menu-Draft.md', 'menu.csv']);
    expect(list.mock.calls.length).toBe(calls);
    view.done();
  });

  it('with no match it says so, and Clear filter (or Esc in the box) brings the rows back', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    const view = await open();
    await type(filterBox(view.host), 'zebra');
    expect(text(view.host)).toContain('No files match ‘zebra’.');
    await click(button(view.host, 'Clear filter'));
    expect(rows(view.host)).toHaveLength(4);
    await type(filterBox(view.host), 'zebra');
    await press('Escape', filterBox(view.host));
    expect(filterBox(view.host).value).toBe('');
    expect(rows(view.host)).toHaveLength(4);
    view.done();
  });

  it('the filter and the sort carry into the next folder for this visit', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    const view = await open();
    await click(view.host.querySelector('button[aria-label="Changed, newest first"]'));
    await click(view.host.querySelector('[data-row-index][aria-label^="sample-bakery"]'));
    expect(rows(view.host)).toEqual(['menu-old.csv', 'recipes.md']);
    expect(view.host.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Changed');
    await type(filterBox(view.host), 'menu');
    expect(rows(view.host)).toEqual(['menu-old.csv']);
    const crumbs = view.host.querySelector('nav[aria-label="Folder path"]');
    await click(
      [...(crumbs?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Shared')
    );
    expect(filterBox(view.host).value).toBe('menu');
    expect(rows(view.host)).toEqual(['Menu-Draft.md', 'menu.csv']);
    view.done();
  });

  it('Changed sorts newest first across folders and files, and says so to a screen reader', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    const view = await open();
    expect(rows(view.host)).toEqual(['sample-bakery', 'Menu-Draft.md', 'menu.csv', 'notes.txt']);
    expect(view.host.querySelector('th[aria-sort="ascending"]')?.textContent).toContain('Name');
    await click(view.host.querySelector('button[aria-label="Changed, newest first"]'));
    expect(rows(view.host)).toEqual(['Menu-Draft.md', 'sample-bakery', 'notes.txt', 'menu.csv']);
    expect(view.host.querySelector('th[aria-sort="descending"]')?.textContent).toContain('Changed');
    view.done();
  });

  it('the list is one tab stop; arrows move, Enter opens a folder (focus on its first row), Backspace goes back up', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    const view = await open();
    const tabStops = () =>
      [...view.host.querySelectorAll('tbody [data-row-index]')].filter(
        (b) => b.getAttribute('tabindex') === '0'
      );
    expect(tabStops()).toHaveLength(1);
    const first = view.host.querySelector<HTMLElement>('[data-row-index="0"]')!;
    first.focus();
    await press('ArrowDown', first);
    expect(document.activeElement?.textContent?.trim()).toBe('Menu-Draft.md');
    expect(tabStops().map((b) => b.textContent?.trim())).toEqual(['Menu-Draft.md']);
    await press('End', document.activeElement);
    expect(document.activeElement?.textContent?.trim()).toBe('notes.txt');
    await press('Home', document.activeElement);
    expect(document.activeElement?.textContent?.trim()).toBe('sample-bakery');
    await press('Enter', document.activeElement);
    expect(list).toHaveBeenCalledWith({ serverId: 's1', path: 'shared/sample-bakery' });
    expect(document.activeElement?.textContent?.trim()).toBe('menu-old.csv');
    await press('Backspace', document.activeElement);
    expect(rows(view.host)).toContain('notes.txt');
    view.done();
  });

  it('Enter on a file previews it; `/` jumps to the filter, but not while typing or with the preview open', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    preview.mockResolvedValue({ ok: true, value: { kind: 'text', text: 'hello' } });
    const view = await open();
    await press('/', document.body);
    expect(document.activeElement).toBe(filterBox(view.host));
    const csv = view.host.querySelector<HTMLElement>('[data-row-index][aria-label^="menu.csv"]')!;
    csv.focus();
    await press('Enter', csv);
    expect(dialog()).not.toBeNull();
    await press('/', dialog());
    expect(document.activeElement).not.toBe(filterBox(view.host));
    view.done();
  });

  it('row actions: Preview opens it, Download saves it safely, Copy path copies it; hovering reads nothing', async () => {
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { rpc } = await import('@renderer/lib/ipc');
    const saveFile = vi.mocked(rpc.cloudFiles.saveFile);
    saveFile.mockResolvedValue({ ok: true, value: undefined } as never);
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(twoLevels);
    preview.mockResolvedValue({ ok: true, value: { kind: 'text', text: 'hello' } });
    const view = await open();
    const row = view.host.querySelector('[data-row-index][aria-label^="menu.csv"]')!.closest('tr')!;
    await act(async () => {
      row.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      row.querySelector<HTMLElement>('[data-row-index]')!.focus();
    });
    expect(preview).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    await click(row.querySelector('button[aria-label="Download menu.csv"]'));
    expect(saveFile).toHaveBeenCalledWith({
      serverId: 's1',
      path: 'shared/menu.csv',
      name: 'menu.csv',
    });
    await click(row.querySelector('[data-row-actions] [data-copy-path]'));
    expect(writeText).toHaveBeenCalledWith('shared/menu.csv');
    expect(row.textContent).toContain('Path copied');
    await click(row.querySelector('button[aria-label="Preview menu.csv"]'));
    expect(dialog()).not.toBeNull();
    // A folder row offers Copy path only.
    const folderRow = view.host.querySelectorAll('tbody tr')[0]!;
    expect(folderRow.querySelector('button[aria-label^="Preview"]')).toBeNull();
    expect(folderRow.querySelector('[data-copy-path="shared/sample-bakery"]')).not.toBeNull();
    view.done();
  });

  it('with more of the folder not loaded, the filter says it only looked at what is', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(async ({ path }: { path: string }) =>
      path === ''
        ? { ok: true, value: { entries: TOP } }
        : { ok: true, value: { entries: SHARED, cursor: 'next' } }
    );
    const view = await open();
    await type(filterBox(view.host), 'menu');
    expect(text(view.host)).toContain(
      'Filtering the first 4 loaded. Show more to include the rest.'
    );
    view.done();
  });
});

describe('Your cloud files, easier to use (part 3: motion)', () => {
  const NESTED = async ({ path }: { path: string }) =>
    path === ''
      ? { ok: true, value: { entries: TOP } }
      : path === 'shared'
        ? { ok: true, value: { entries: [folder('sample-bakery'), file('menu.csv')] } }
        : { ok: true, value: { entries: [file('recipes.md')] } };
  const motionDirection = (host: HTMLElement) =>
    host.querySelector('[data-folder-motion]')?.getAttribute('data-folder-motion');

  it('the waking cloud shows only after Wake it, as a status, with the spec’s words and no spinner', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: false, code: 'box_resting' });
    const view = await open();
    expect(view.host.querySelector('[data-explorer-waking]')).toBeNull();
    await click(button(view.host, 'Wake it'));
    const waking = view.host.querySelector('[data-explorer-waking]');
    expect(waking?.getAttribute('role')).toBe('status');
    expect(waking?.textContent).toContain('Waking your cloud…');
    // The spec's words exactly, the same as Switch web.
    expect(waking?.textContent).toContain('This takes about a minute');
    expect(waking?.textContent).not.toContain('as soon as');
    expect(waking?.querySelector('[class*="animate-spin"]')).toBeNull();
    expect(ensureCloudMachine).toHaveBeenCalledTimes(1);
    view.done();
  });

  it('a folder change slides in going into a folder, back going up, and only fades for a jump', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(NESTED);
    const view = await open();
    await click(view.host.querySelector('[data-row-index][aria-label^="sample-bakery"]'));
    expect(motionDirection(view.host)).toBe('1');
    const crumbs = view.host.querySelector('section nav[aria-label="Folder path"]');
    await click(
      [...(crumbs?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Shared')
    );
    expect(motionDirection(view.host)).toBe('-1');
    const tree = view.host.querySelector('nav[aria-label="Folders"]');
    await click(
      [...(tree?.querySelectorAll('button') ?? [])].find((b) => b.textContent === 'Baker')
    );
    expect(motionDirection(view.host)).toBe('0');
    view.done();
  });

  it('the tree’s chevron turns as a folder opens, and its children grow in from what was read on that click', async () => {
    flagsState.set('s1', on('s1'));
    list.mockImplementation(NESTED);
    const view = await open();
    const toggle = view.host.querySelector<HTMLButtonElement>('button[aria-label="Open Shared"]')!;
    expect(toggle.querySelector('svg')?.getAttribute('data-open')).toBe('false');
    expect(list).not.toHaveBeenCalledWith({ serverId: 's1', path: 'shared' });
    await click(toggle);
    expect(list).toHaveBeenCalledWith({ serverId: 's1', path: 'shared' });
    expect(
      view.host.querySelector('button[aria-label="Close Shared"] svg')?.getAttribute('data-open')
    ).toBe('true');
    // It turns (one chevron rotating), and turns only while motion is allowed.
    const chevron = view.host.querySelector('button[aria-label="Close Shared"] svg');
    expect(chevron?.getAttribute('class')).toContain('rotate-90');
    expect(chevron?.getAttribute('class')).toContain('motion-reduce:transition-none');
    expect(
      view.host.querySelector('button[aria-label="Open Baker"] svg')?.getAttribute('class')
    ).not.toContain('rotate-90');
    expect(view.host.querySelector('[data-tree-children="shared"]')).not.toBeNull();
    // Nothing deeper is read ahead: only the folder clicked.
    expect(list).not.toHaveBeenCalledWith({ serverId: 's1', path: 'shared/sample-bakery' });
    view.done();
  });

  it('the preview grows from the row it was opened from', async () => {
    flagsState.set('s1', on('s1'));
    params.value = { serverId: 's1', path: 'shared' };
    list.mockImplementation(NESTED);
    preview.mockResolvedValue({ ok: true, value: { kind: 'text', text: 'item,price' } });
    const view = await open();
    await click(view.host.querySelector('[data-row-index][aria-label^="menu.csv"]'));
    const grow = dialog()?.querySelector<HTMLElement>('[data-preview-motion]');
    expect(grow).not.toBeNull();
    expect(grow?.style.transformOrigin).toMatch(/^\d+px \d+px$/);
    view.done();
  });
});

describe('Your cloud files at phone width', () => {
  it('the folder tree steps aside below 640 px, so the list and its "⋯" menus fit; the breadcrumb still leads back up', async () => {
    flagsState.set('s1', on('s1'));
    list.mockResolvedValue({ ok: true, value: { entries: TOP } });
    const view = await open();
    expect(view.host.querySelector('nav[aria-label="Folders"]')?.className).toContain(
      'max-sm:hidden'
    );
    expect(
      view.host.querySelector('section nav[aria-label="Folder path"]')?.className
    ).not.toContain('hidden');
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
