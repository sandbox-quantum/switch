import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

vi.mock('./app-state', () => ({
  appState: {
    history: { push: vi.fn() },
  },
}));

const { NavigationStore } = await import('./navigation-store');

function buildStore() {
  const store = new NavigationStore();
  store.registerView('home');
  store.registerView('location');
  store.registerView('session');
  store.registerView('settings');
  return store;
}

describe('NavigationStore.restoreSnapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('restores a snapshot whose view is registered', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'location',
      viewParams: { location: { locationId: 'p1' } },
    });
    expect(store.currentViewId).toBe('location');
    expect(store.viewParamsStore.location).toEqual({ locationId: 'p1' });
    expect(store.lastNonSettingsView).toBe('location');
  });

  it('falls back to home when the persisted view is not in the registry', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'phantom-view-from-old-build',
      viewParams: { location: { locationId: 'p1' } },
    });
    expect(store.currentViewId).toBe('home');
    expect(store.lastNonSettingsView).toBe('home');
  });

  it('strips viewParams entries whose key is not a registered view', () => {
    const store = buildStore();
    store.restoreSnapshot({
      currentViewId: 'home',
      viewParams: {
        location: { locationId: 'p1' },
        ghostView: { stale: true },
      },
    });
    expect(store.viewParamsStore.location).toEqual({ locationId: 'p1' });
    expect((store.viewParamsStore as Record<string, unknown>).ghostView).toBeUndefined();
  });

  it('does not touch lastNonSettingsView when the persisted view is settings', () => {
    const store = buildStore();
    store.restoreSnapshot({ currentViewId: 'settings' });
    expect(store.currentViewId).toBe('settings');
    expect(store.lastNonSettingsView).toBe('home');
  });

  it('honors a guard redirect after a valid view is restored', () => {
    const store = buildStore();
    store.registerGuard('location', () => ({ ok: false, redirect: 'home' }));
    store.restoreSnapshot({
      currentViewId: 'location',
      viewParams: { location: { locationId: 'gone' } },
    });
    expect(store.currentViewId).toBe('home');
  });
});
