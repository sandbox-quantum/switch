import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { HomeMainPanel } from '@renderer/app/home-view';
import { appSettingsMetaQueryKey } from '@renderer/features/settings/app-settings-client';
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

async function renderHome({
  showChecklist = true,
}: { showChecklist?: boolean } = {}): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  // The welcome screen reads onboarding progress through React Query, so it
  // needs a client even though nothing here resolves.
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // The checklist is hidden until the setting says otherwise, and the test
  // bridge answers every IPC call with `undefined` — so without seeding this
  // there is no checklist on screen to make assertions about.
  queryClient.setQueryData(appSettingsMetaQueryKey('onboarding'), {
    value: { showChecklist },
    defaults: { showChecklist: true },
    overrides: {},
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={queryClient}>
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
      </QueryClientProvider>
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

  it('opts the checklist out so its steps stay clickable', async () => {
    const el = await renderHome();
    const step = [...el.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Add a server'
    );

    expect(step).toBeDefined();
    expect(step?.closest('[class*="[-webkit-app-region:no-drag]"]')).not.toBeNull();
  });

  it('drops the checklist once it has been dismissed', async () => {
    const el = await renderHome({ showChecklist: false });

    expect(el.textContent).not.toContain('Setting up Switch');
    // The rest of the welcome screen is not the checklist's to take with it.
    expect(el.textContent).toContain('Learn more');
  });
});
