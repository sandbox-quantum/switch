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

describe('openablePath', () => {
  it('opens plain names only', () => {
    expect(openablePath('shared/sample-bakery')).toBe('shared/sample-bakery');
    for (const bad of ['', '/etc', 'a/../b', './a', 'a//b', 'a/', 7, undefined, 'a\0b'])
      expect(openablePath(bad)).toBeNull();
  });
});
