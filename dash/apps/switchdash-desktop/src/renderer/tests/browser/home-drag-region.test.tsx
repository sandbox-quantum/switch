import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeMainPanel } from '@renderer/app/home-view';
import { ThemeContext } from '@renderer/lib/providers/theme-provider';

/**
 * The home view is the one screen that registers no `TitlebarSlot`, so it has
 * no `Titlebar` supplying a `-webkit-app-region: drag` strip. Without a drag
 * region of its own the frameless window can only be moved by grabbing the
 * sidebar's top strip (CHOO-1430).
 *
 * Electron is the only place a drag region actually does anything, so these
 * assertions are on the markup rather than on behaviour: they exist to catch a
 * restyle or refactor silently dropping the utility classes again.
 *
 * The imports above must stay static; `setup-electron-bridge.ts` exists so they
 * can be, and explains what importing this module at runtime does to React.
 */

let container: HTMLDivElement | null = null;

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
