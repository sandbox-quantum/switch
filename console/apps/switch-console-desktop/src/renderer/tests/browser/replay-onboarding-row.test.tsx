/**
 * The settings row that opens the first-run pages again. It exists for the
 * people building Switch, so a stable build must not show it at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ devTools: true, navigate: vi.fn() }));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/dev-tools', () => ({ showDevTools: () => state.devTools }));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: state.navigate }),
}));

import { onboardingStore } from '@renderer/features/onboarding/onboarding-store';
import { ReplayOnboardingRow } from '@renderer/features/settings/components/ReplayOnboardingRow';

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<ReplayOnboardingRow />));
  return container;
}

beforeEach(() => {
  state.devTools = true;
  state.navigate.mockReset();
  onboardingStore.reset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  onboardingStore.reset();
});

describe('the replay first-run pages row', () => {
  it('is not there on a stable build', async () => {
    state.devTools = false;
    const el = await render();

    expect(el.textContent).toBe('');
  });

  it('opens the first-run pages from the start and leaves Settings', async () => {
    const el = await render();
    const replay = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Replay');

    await act(async () => replay!.click());

    expect(onboardingStore.rehearsal).toBe(true);
    expect(onboardingStore.page).toBe('welcome');
    expect(state.navigate).toHaveBeenCalledWith('home');
  });
});
