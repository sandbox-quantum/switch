// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

// A Markdown file from the person's cloud never runs or fetches anything: no
// raw HTML, images as alt text only, and only https links open (after a confirm).

const confirmOpenExternalLink = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/open-external-link', () => ({ confirmOpenExternalLink }));

const { FileMarkdown, FileText, opensLink } = await import('./file-markdown');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function show(element: ReturnType<typeof createElement>) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(element));
  return { host, done: () => act(() => root.unmount()) };
}

const HOSTILE = [
  '# Readme',
  '<script>window.ran = 1</script>',
  '<img src="x" onerror="window.ran = 2">',
  '<iframe src="https://evil.example/"></iframe>',
  '<a href="javascript:window.ran=3">raw link</a>',
  '![tracker](https://evil.example/pixel.png)',
  '![local](../agents/x/credentials.json)',
  '[safe](https://example.com/docs)',
  '[js](javascript:window.ran=4)',
  '[data](data:text/html,<script>1</script>)',
  '[file](file:///etc/passwd)',
  '[plain](http://example.com/)',
  '[relative](../secrets/key)',
].join('\n\n');

describe('FileMarkdown', () => {
  it('renders no raw HTML: no script, iframe or img element, and nothing runs', async () => {
    const view = await show(createElement(FileMarkdown, { text: HOSTILE }));
    expect(view.host.querySelector('h1')?.textContent).toBe('Readme');
    expect(view.host.querySelectorAll('script, iframe, img, object, embed').length).toBe(0);
    expect((window as { ran?: number }).ran).toBeUndefined();
    view.done();
  });

  it('shows an image as its alt text, so no request is made for it', async () => {
    const view = await show(createElement(FileMarkdown, { text: HOSTILE }));
    const placeholders = [...view.host.querySelectorAll('[data-image-placeholder]')];
    expect(placeholders.map((p) => p.textContent)).toEqual(['[image: tracker]', '[image: local]']);
    expect(view.host.innerHTML).not.toContain('evil.example/pixel.png');
    expect(view.host.innerHTML).not.toContain('credentials.json');
    view.done();
  });

  it('only the https link is a link, and it opens through the confirm', async () => {
    const view = await show(createElement(FileMarkdown, { text: HOSTILE }));
    const links = [...view.host.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/docs']);
    await act(async () => links[0]!.click());
    expect(confirmOpenExternalLink).toHaveBeenCalledWith('https://example.com/docs');
    for (const label of ['js', 'data', 'file', 'plain', 'relative'])
      expect(view.host.textContent).toContain(label);
    view.done();
  });
});

describe('opensLink', () => {
  it('opens https only', () => {
    expect(opensLink('https://example.com')).toBe(true);
    for (const href of [
      'http://example.com',
      'javascript:alert(1)',
      'data:text/html,x',
      'file:///x',
      '../x',
      '',
      undefined,
    ])
      expect(opensLink(href)).toBe(false);
  });
});

describe('FileText', () => {
  it('shows markup as text, never as elements', async () => {
    const view = await show(createElement(FileText, { text: '<script>x</script><b>bold</b>' }));
    expect(view.host.querySelector('pre')?.textContent).toBe('<script>x</script><b>bold</b>');
    expect(view.host.querySelectorAll('script, b').length).toBe(0);
    view.done();
  });
});
