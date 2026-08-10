import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
/**
 * The embedded room view depends on React actually emitting `allowpopups` onto
 * the `<webview>` tag.
 *
 * Without that attribute Electron blocks the guest's popups outright — they
 * never reach the window-open handler in the main process — and every external
 * link in a Mattermost message silently does nothing when clicked. It is one
 * attribute on a non-standard element that React has no built-in knowledge of,
 * so it is exactly the kind of thing a React or typing upgrade could quietly
 * drop.
 */
import { WEBVIEW_ALLOW_POPUPS } from '@renderer/features/switch-rooms/webview-attrs';

let container: HTMLDivElement | null = null;

afterEach(() => {
  container?.remove();
  container = null;
});

describe('<webview allowpopups>', () => {
  it('renders the attribute onto the DOM element', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <webview src="http://127.0.0.1:1/x" partition="persist:test" {...WEBVIEW_ALLOW_POPUPS} />
      );
    });

    const el = container.querySelector('webview');
    expect(el).not.toBeNull();
    expect(el?.hasAttribute('allowpopups')).toBe(true);

    await act(async () => root.unmount());
  });

  it('omits the attribute when not asked for, so the default stays restrictive', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<webview src="http://127.0.0.1:1/x" partition="persist:test" />);
    });

    expect(container.querySelector('webview')?.hasAttribute('allowpopups')).toBe(false);

    await act(async () => root.unmount());
  });
});
