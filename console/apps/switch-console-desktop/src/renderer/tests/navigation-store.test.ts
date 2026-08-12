import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GuardResult, ViewId } from '@renderer/app/view-registry';

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { history: { push: vi.fn() } },
}));

vi.mock('@renderer/lib/modal/modal-store', () => ({
  modalStore: { closeModal: vi.fn() },
}));

const { NavigationStore } = await import('@renderer/lib/stores/navigation-store');

/** The retired Settings tab that CHOO-1809 moved out to its own view. */
const staleTab = { tab: 'remote-hosts' };

/** Mirrors `settingsView.canActivate`: the params name something retired. */
function staleParamGuard(params: unknown): GuardResult {
  const tab =
    typeof params === 'object' && params !== null ? (params as { tab?: unknown }).tab : undefined;
  return tab === 'remote-hosts'
    ? { ok: false, redirect: 'remoteHosts', discardParams: true }
    : { ok: true };
}

function makeStore(guards: Partial<Record<ViewId, (params: unknown) => GuardResult>>) {
  const store = new NavigationStore();
  for (const viewId of ['home', 'settings', 'remoteHosts', 'session'] as ViewId[]) {
    store.registerView(viewId);
  }
  for (const [viewId, guard] of Object.entries(guards)) {
    store.registerGuard(viewId as ViewId, guard);
  }
  return store;
}

describe('NavigationStore stale-param guards', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    store = makeStore({ settings: staleParamGuard });
  });

  it('redirects away from params naming a retired value', () => {
    store.restoreSnapshot({ currentViewId: 'settings', viewParams: { settings: staleTab } });

    expect(store.currentViewId).toBe('remoteHosts');
  });

  it('does not strand the view: a second attempt reaches it', () => {
    store.restoreSnapshot({ currentViewId: 'settings', viewParams: { settings: staleTab } });

    // The redirect is a one-time migration, so the stale tab must not survive to
    // be handed back to the guard by navigate()'s fallback to stored params.
    store.navigate('settings');

    expect(store.currentViewId).toBe('settings');
  });

  it('reaches the view when navigating from elsewhere with no params', () => {
    // The trap this covers: currentViewId is something else entirely, so restore
    // never runs the guard, and the stale tab sits in the store until the first
    // click on Settings — which then bounces, and every click after it.
    store.restoreSnapshot({ currentViewId: 'home', viewParams: { settings: staleTab } });

    store.navigate('settings');
    expect(store.currentViewId).toBe('remoteHosts');

    store.navigate('settings');
    expect(store.currentViewId).toBe('settings');
  });

  it('drops only the offending view params', () => {
    store.restoreSnapshot({
      currentViewId: 'home',
      viewParams: { settings: staleTab, session: { sessionId: 's1' } },
    });

    store.navigate('settings');

    expect(store.snapshot.viewParams.settings).toBeUndefined();
    expect(store.snapshot.viewParams.session).toEqual({ sessionId: 's1' });
  });

  it('keeps params for a guard that rejects on runtime state', () => {
    // sessionView and locationView reject while their location is still loading.
    // Those params are good; discarding them would lose the restored session.
    let loaded = false;
    const runtimeGuard = (): GuardResult =>
      loaded ? { ok: true } : { ok: false, redirect: 'home' };
    store = makeStore({ session: runtimeGuard });
    store.restoreSnapshot({
      currentViewId: 'session',
      viewParams: { session: { sessionId: 's1' } },
    });
    expect(store.currentViewId).toBe('home');

    loaded = true;
    store.navigate('session');

    expect(store.currentViewId).toBe('session');
    expect(store.snapshot.viewParams.session).toEqual({ sessionId: 's1' });
  });
});
