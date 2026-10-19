/**
 * A link to a Console page in a chat message is a link, and clicking it moves
 * the app there instead of trying to leave it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

const openConsoleLink = vi.hoisted(() => vi.fn());
const confirmOpenExternalLink = vi.hoisted(() => vi.fn());
vi.mock('@renderer/features/deeplinks/console-link-handler', () => ({
  followConsoleLink: openConsoleLink,
}));
vi.mock('@renderer/lib/open-external-link', () => ({ confirmOpenExternalLink }));

import { ChatMarkdown } from '@renderer/features/chats/ui/chat-markdown';
import '@renderer/index.css';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(markdown: string) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ChatMarkdown>{markdown}</ChatMarkdown>));
  // Streamdown renders after a tick.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
}

function link(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('a, [data-streamdown="link"]')].find(
    (each) => each.textContent?.trim() === text
  );
  if (!found) throw new Error(`no link "${text}" in ${container?.innerHTML}`);
  return found;
}

describe('links to Console pages in chat', () => {
  it('open the page in the app', async () => {
    await render('Go to [Connect a messaging app](switchdash://open/messaging-apps/connect).');
    await act(async () => link('Connect a messaging app').click());
    expect(openConsoleLink).toHaveBeenCalledWith('switchdash://open/messaging-apps/connect');
    expect(confirmOpenExternalLink).not.toHaveBeenCalled();
  });

  it('leave web links to the confirm dialog', async () => {
    await render('See [the docs](https://example.test/docs).');
    await act(async () => link('the docs').click());
    expect(confirmOpenExternalLink).toHaveBeenCalledWith('https://example.test/docs');
    expect(openConsoleLink).not.toHaveBeenCalled();
  });
});
