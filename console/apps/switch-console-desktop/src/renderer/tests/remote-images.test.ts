// @vitest-environment jsdom
import { act, createElement, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: { on: vi.fn(() => () => {}) },
  rpc: { app: { openExternal: vi.fn() } },
}));

const { ChatMarkdown } = await import('@switch-console/chat-ui/ui/chat-markdown');
const { withChatHost } = await import('@switch-console/chat-ui/testing');
const { MarkdownRenderer } = await import('@renderer/lib/ui/markdown-renderer');
const { loadsFromElsewhere } = await import('@switch-console/chat-ui/ui/ask-before-loading');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PIXEL = 'https://tracker.example/pixel.png?viewer=1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render(node: ReactElement) {
  await act(async () => root.render(node));
}

/** Everything in the page that would make the browser fetch the image. */
function fetchesOf(src: string): Element[] {
  return [...document.querySelectorAll('img, link')].filter(
    (el) => el.getAttribute('src') === src || el.getAttribute('href') === src
  );
}

async function loadImage() {
  const button = [...container.querySelectorAll('button')].find(
    (b) => b.textContent === 'Load image'
  );
  if (!button) throw new Error(`No "Load image" in: ${container.textContent}`);
  await act(async () => button.click());
}

describe.each([
  ['a chat message', () => withChatHost(createElement(ChatMarkdown, null, `![Pixel](${PIXEL})`))],
  [
    'a room document',
    () => createElement(MarkdownRenderer, { content: `![Pixel](${PIXEL})`, variant: 'compact' }),
  ],
  [
    'a full document',
    () => createElement(MarkdownRenderer, { content: `![Pixel](${PIXEL})`, variant: 'full' }),
  ],
])('an image from another computer in %s', (_where, element) => {
  it('has no live address until the reader clicks Load image', async () => {
    await render(element());
    expect(fetchesOf(PIXEL)).toEqual([]);
    expect(container.textContent).toContain('Image from tracker.example');

    await loadImage();
    const images = container.querySelectorAll(`img[src="${PIXEL}"]`);
    expect(images.length).toBeGreaterThan(0);
    for (const image of images) expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
  });
});

describe('loadsFromElsewhere', () => {
  it('is true for an address on another computer, however it is written', () => {
    expect(loadsFromElsewhere('https://tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere('http://tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere('//tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere('/\\tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere(' https://tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere('ftp://tracker.example/a.png')).toBe(true);
    expect(loadsFromElsewhere('http://[')).toBe(true);
  });

  it('is false for an image already here, or the app’s own', () => {
    expect(loadsFromElsewhere('data:image/png;base64,iVBORw0KGgo=')).toBe(false);
    expect(loadsFromElsewhere('blob:https://renderer.invalid/1234')).toBe(false);
    expect(loadsFromElsewhere('screenshots/one.png')).toBe(false);
    expect(loadsFromElsewhere('/assets/logo.png')).toBe(false);
  });
});
