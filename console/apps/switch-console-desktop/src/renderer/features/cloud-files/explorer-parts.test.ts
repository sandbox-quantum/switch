// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COPIED_MS,
  CopyPathButton,
  EmptyFolder,
  EXPLORER_WORDS,
  FileKindIcon,
  ListSkeleton,
  TreeSkeleton,
} from './explorer-parts';

// The explorer's small parts: placeholders in place of spinners, the empty
// folder's words, the kind icon, and Copy path's two-second "Path copied".

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const writeText = vi.fn(async (_text: string) => {});

beforeEach(() => {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  writeText.mockReset();
  writeText.mockImplementation(async () => {});
  document.body.innerHTML = '';
});

async function show(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, done: () => act(() => root.unmount()) };
}

describe('explorer parts', () => {
  it('placeholders say they are loading to a screen reader, and pulse only when motion is allowed', async () => {
    const list = await show(createElement(ListSkeleton));
    const status = list.host.querySelector('[role="status"]');
    expect(status?.getAttribute('aria-label')).toBe('Loading files…');
    const row = status?.firstElementChild;
    expect(row?.className).toContain('motion-safe:animate-pulse');
    expect(row?.className).toContain('motion-reduce:opacity-70');
    expect(row?.className).not.toMatch(/(^|\s)animate-pulse/);
    list.done();
    const tree = await show(createElement(TreeSkeleton));
    expect(tree.host.querySelector('[role="status"]')?.getAttribute('aria-label')).toBe(
      'Loading files…'
    );
    tree.done();
  });

  it('an empty folder says so, and an agent’s own folder says its files appear there', async () => {
    const plain = await show(createElement(EmptyFolder, { agentFolder: false }));
    expect(plain.host.textContent).toBe('This folder is empty.');
    plain.done();
    const agent = await show(createElement(EmptyFolder, { agentFolder: true }));
    expect(agent.host.textContent).toBe('Nothing here yet. Files your agent makes appear here.');
    agent.done();
  });

  it('the kind icon is hidden from screen readers, and a folder shows open when asked', async () => {
    const view = await show(
      createElement('div', null, [
        createElement(FileKindIcon, { key: 'a', entry: { name: 'a.md', kind: 'file' } }),
        createElement(FileKindIcon, { key: 'b', entry: { name: 'f', kind: 'folder' }, open: true }),
      ])
    );
    const icons = [...view.host.querySelectorAll('svg')];
    expect(icons.map((icon) => icon.getAttribute('data-file-kind'))).toEqual([
      'markdown',
      'folder',
    ]);
    expect(icons.every((icon) => icon.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(icons[1]?.getAttribute('class')).toContain('lucide-folder-open');
    view.done();
  });

  it('Copy path copies the path within Your cloud files, says "Path copied" for two seconds, then goes back', async () => {
    vi.useFakeTimers();
    const view = await show(createElement(CopyPathButton, { path: 'web-frontend/src/app.ts' }));
    const button = view.host.querySelector('button')!;
    expect(button.textContent).toBe(EXPLORER_WORDS.copyPath);
    await act(async () => button.click());
    expect(writeText).toHaveBeenCalledWith('web-frontend/src/app.ts');
    expect(button.textContent).toBe('Path copied');
    await act(async () => vi.advanceTimersByTime(COPIED_MS - 1));
    expect(button.textContent).toBe('Path copied');
    await act(async () => vi.advanceTimersByTime(1));
    expect(button.textContent).toBe('Copy path');
    view.done();
  });

  it('if the clipboard refuses, it never says "Path copied"', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const view = await show(createElement(CopyPathButton, { path: 'a.txt' }));
    await act(async () => view.host.querySelector('button')!.click());
    expect(view.host.textContent).toBe('Copy path');
    view.done();
  });
});
