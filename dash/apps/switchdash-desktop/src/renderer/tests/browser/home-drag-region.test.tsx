import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type * as HomeView from '@renderer/app/home-view';
import type * as ThemeProvider from '@renderer/lib/providers/theme-provider';

/**
 * The home view is the one screen that registers no `TitlebarSlot`, so it has
 * no `Titlebar` supplying a `-webkit-app-region: drag` strip. Without a drag
 * region of its own the frameless window can only be moved by grabbing the
 * sidebar's top strip (CHOO-1430).
 *
 * Electron is the only place a drag region actually does anything, so these
 * assertions are on the markup rather than on behaviour: they exist to catch a
 * restyle or refactor silently dropping the utility classes again.
 */

let ThemeContext: typeof ThemeProvider.ThemeContext;
let HomeMainPanel: typeof HomeView.HomeMainPanel;
let container: HTMLDivElement | null = null;

beforeAll(async () => {
  // `lib/ipc` reads the preload bridge at module scope and the home view pulls
  // it in transitively, so the bridge has to exist before the import runs.
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      invoke: async () => undefined,
      eventSend: () => {},
      eventOn: () => () => {},
    },
  });
  ({ HomeMainPanel } = await import('@renderer/app/home-view'));
  // The real ThemeProvider resolves the theme over RPC; the panel only reads
  // `effectiveTheme` to pick logo colours, so feed the context directly.
  ({ ThemeContext } = await import('@renderer/lib/providers/theme-provider'));
});

async function renderHome(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <ThemeContext.Provider
        value={{
          theme: null,
          setTheme: () => {},
          toggleTheme: () => {},
          effectiveTheme: 'emlight',
        }}
      >
        <HomeMainPanel />
      </ThemeContext.Provider>
    )
  );
  return container;
}

afterEach(() => {
  container?.remove();
  container = null;
});

describe('home view drag region', () => {
  it('makes the whole onboarding surface draggable', async () => {
    const el = await renderHome();
    const surface = el.firstElementChild;

    expect(surface).not.toBeNull();
    expect(surface?.className).toContain('[-webkit-app-region:drag]');
  });

  it('opts the action list out so its buttons stay clickable', async () => {
    const el = await renderHome();
    const action = el.querySelector('button[aria-label="Add Switch agent"]');

    expect(action).not.toBeNull();
    expect(action?.closest('[class*="[-webkit-app-region:no-drag]"]')).not.toBeNull();
  });
});
