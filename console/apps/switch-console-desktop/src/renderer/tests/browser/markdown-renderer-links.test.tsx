/**
 * A link in a room document, a library item or a transcript is never left to
 * the browser: a web link goes to the confirm dialog, and any other scheme or a
 * relative path is refused, instead of opening an app window or an OS handler.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const confirmOpenExternalLink = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/open-external-link', () => ({ confirmOpenExternalLink }));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';
import '@renderer/index.css';

const CONTENT = [
  '[web](https://example.test/docs)',
  '[mail](mailto:someone@example.test)',
  '[irc](irc://irc.example.test/room)',
  '[xmpp](xmpp:someone@example.test)',
  '[relative](/etc/passwd)',
].join(' | ');

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  vi.clearAllMocks();
});

async function render(variant: 'full' | 'compact') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<MarkdownRenderer content={CONTENT} variant={variant} />));
}

function link(text: string): HTMLAnchorElement {
  const found = [...container!.querySelectorAll('a')].find((a) => a.textContent === text);
  if (!found) throw new Error(`no link "${text}" in ${container?.innerHTML}`);
  return found;
}

/** Dispatch a click and say whether the browser was kept from following it. */
function press(text: string, init: MouseEventInit = {}, type = 'click'): boolean {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
  act(() => {
    link(text).dispatchEvent(event);
  });
  return event.defaultPrevented;
}

describe.each(['full', 'compact'] as const)('links in %s markdown', (variant) => {
  it('send a web link to the confirm dialog', async () => {
    await render(variant);
    expect(press('web')).toBe(true);
    expect(confirmOpenExternalLink).toHaveBeenCalledWith('https://example.test/docs');
    expect(toast).not.toHaveBeenCalled();
  });

  it.each(['mail', 'irc', 'xmpp', 'relative'])(
    'refuse the %s link, with a notice, instead of letting it open',
    async (text) => {
      await render(variant);
      expect(press(text)).toBe(true);
      expect(confirmOpenExternalLink).not.toHaveBeenCalled();
      expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Link not opened' }));
    }
  );

  it('keep a middle-click from opening a window', async () => {
    await render(variant);
    expect(press('relative', { button: 1 }, 'auxclick')).toBe(true);
    expect(press('web', { button: 1 }, 'auxclick')).toBe(true);
    expect(confirmOpenExternalLink).toHaveBeenCalledWith('https://example.test/docs');
  });
});
