/**
 * The settings row that opens the first-run pages again. It exists for the
 * people building Switch, so a stable build must not show it at all.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  devTools: true,
  navigate: vi.fn(),
  replayAsFreshInstall: vi.fn(),
  showModal: vi.fn(),
  toastError: vi.fn(),
}));

vi.hoisted(() => {
  window.electronAPI ??= {
    invoke: () => Promise.resolve(undefined),
    eventOn: () => () => {},
    eventSend: () => {},
  } as unknown as typeof window.electronAPI;
});

vi.mock('@renderer/lib/dev-tools', () => ({ showDevTools: () => state.devTools }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { app: { replayAsFreshInstall: state.replayAsFreshInstall } },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => (args: unknown) => state.showModal(id, args),
}));

vi.mock('sonner', () => ({ toast: { error: state.toastError } }));

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
  state.replayAsFreshInstall.mockReset();
  state.showModal.mockReset();
  state.toastError.mockReset();
  onboardingStore.reset();
});

function button(el: HTMLElement, label: string): HTMLButtonElement {
  return [...el.querySelectorAll('button')].find((b) => b.textContent === label)!;
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = null;
  root = null;
  onboardingStore.reset();
});

describe('the replay onboarding row', () => {
  it('is not there on a stable build', async () => {
    state.devTools = false;
    const el = await render();

    expect(el.textContent).toBe('');
  });

  it('opens the first-run pages from the start and leaves Settings', async () => {
    const el = await render();
    await act(async () => button(el, 'Pages only').click());

    expect(onboardingStore.rehearsal).toBe(true);
    expect(onboardingStore.page).toBe('welcome');
    expect(state.navigate).toHaveBeenCalledWith('noServer');
  });

  it('asks before a fresh install, and does nothing until confirmed', async () => {
    const el = await render();

    await act(async () => button(el, 'Fresh install').click());

    expect(state.showModal).toHaveBeenCalledWith(
      'confirmActionModal',
      expect.objectContaining({ title: 'Restart as a fresh install?', confirmLabel: 'Restart' })
    );
    expect(state.replayAsFreshInstall).not.toHaveBeenCalled();
  });

  it('restarts as a fresh install once confirmed', async () => {
    state.replayAsFreshInstall.mockResolvedValue({ success: true });
    const el = await render();
    await act(async () => button(el, 'Fresh install').click());

    await act(async () => state.showModal.mock.calls[0][1].onSuccess());

    expect(state.replayAsFreshInstall).toHaveBeenCalled();
    expect(state.toastError).not.toHaveBeenCalled();
  });

  it('shows why a fresh install could not start', async () => {
    state.replayAsFreshInstall.mockResolvedValue({
      success: false,
      error: 'Only in dev and Canary builds.',
    });
    const el = await render();
    await act(async () => button(el, 'Fresh install').click());

    await act(async () => state.showModal.mock.calls[0][1].onSuccess());

    expect(state.toastError).toHaveBeenCalledWith('Could not restart as a fresh install.', {
      description: 'Only in dev and Canary builds.',
    });
  });
});
