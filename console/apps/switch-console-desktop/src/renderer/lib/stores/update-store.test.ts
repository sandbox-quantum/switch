import { beforeEach, describe, expect, it, vi } from 'vitest';
import { menuCheckForUpdatesChannel } from '@shared/events/appEvents';
import {
  updateAvailableEvent,
  updateCheckingEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateInstallFailedEvent,
  updateInstallingEvent,
  updateNotAvailableEvent,
} from '@shared/events/updateEvents';

const handlers = vi.hoisted(() => new Map<unknown, (payload?: unknown) => void>());
const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn() }));
const rpcUpdate = vi.hoisted(() => ({
  getState: vi.fn(),
  check: vi.fn(),
  openLatest: vi.fn(),
  openReleaseNotes: vi.fn(),
}));

vi.mock('sonner', () => ({ toast }));
vi.mock('@renderer/lib/components/update-toast-action-label', () => ({
  createUpdateToastActionLabel: (text: string) => text,
}));
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: { navigation: { navigate: vi.fn() } },
}));
vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: (event: unknown, handler: (payload?: unknown) => void) => {
      handlers.set(event, handler);
    },
  },
  rpc: {
    app: { getAppVersion: () => Promise.resolve('1.0.0') },
    update: rpcUpdate,
  },
}));

const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
});

const {
  UPDATE_AVAILABLE_TOAST_ID,
  UPDATE_INSTALL_FAILED_TOAST_ID,
  UpdateStore,
  mainStateToRendererState,
} = await import('./update-store');
const { appState } = await import('@renderer/lib/stores/app-state');

beforeEach(() => {
  rpcUpdate.getState.mockResolvedValue({ success: false });
  rpcUpdate.check.mockResolvedValue(null);
  rpcUpdate.openLatest.mockResolvedValue({ success: true });
});

function emit(event: unknown, payload?: unknown): void {
  const handler = handlers.get(event);
  if (!handler) throw new Error('no handler registered for the event');
  handler(payload);
}

/** A started store, past the check that every start makes. */
async function startedStore(): Promise<InstanceType<typeof UpdateStore>> {
  const store = new UpdateStore();
  store.start();
  await vi.waitFor(() => expect(rpcUpdate.check).toHaveBeenCalledWith('startup'));
  rpcUpdate.check.mockClear();
  return store;
}

describe('the "Update Available" toast', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    localStorage.clear();
    new UpdateStore().start();
  });

  it('replaces the previous one rather than stacking another', () => {
    emit(updateAvailableEvent, { version: '2.0.0' });
    emit(updateAvailableEvent, { version: '2.1.0' });

    expect(toast).toHaveBeenCalledTimes(2);
    for (const [, options] of toast.mock.calls) {
      expect(options).toMatchObject({ id: UPDATE_AVAILABLE_TOAST_ID });
    }
  });

  it.each([
    ['download starts', updateDownloadingEvent],
    ['download finishes', updateDownloadedEvent],
    ['install starts', updateInstallingEvent],
    ['update is no longer offered', updateNotAvailableEvent],
  ])('closes when the %s, and closes nothing else', (_label, event) => {
    emit(updateAvailableEvent, { version: '2.0.0' });

    emit(event, { version: '2.0.0' });

    expect(toast.dismiss).toHaveBeenCalled();
    for (const args of toast.dismiss.mock.calls) {
      expect(args).toEqual([UPDATE_AVAILABLE_TOAST_ID]);
    }
  });
});

describe('an update that did not install', () => {
  const message = "Version 2.0.0 didn't install: Switch Console restarted on version 1.0.0.";

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    localStorage.clear();
  });

  it('shows a failure after a click only where the user clicked', () => {
    const store = new UpdateStore();
    store.start();

    emit(updateInstallFailedEvent, { version: '2.0.0', message, foundAtLaunch: false });

    // The panel or the Settings card renders this state; a toast would repeat it.
    expect(store.state).toEqual({ status: 'install-failed', message });
    expect(store.latestVersion).toBe('2.0.0');
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('tells the user about a failure found at launch, and points at Settings', () => {
    const store = new UpdateStore();
    store.start();

    emit(updateInstallFailedEvent, { version: '2.0.0', message, foundAtLaunch: true });

    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error).toHaveBeenCalledWith(
      "Update didn't install",
      expect.objectContaining({ id: UPDATE_INSTALL_FAILED_TOAST_ID, description: message })
    );

    // "Download manually" quits the app, so the toast leads to the card that
    // explains it rather than running it from a corner of the screen.
    const [, options] = toast.error.mock.calls[0] as [
      string,
      { action: { label: unknown; onClick(): void } },
    ];
    expect(options.action.label).toBe('Details');
    options.action.onClick();
    expect(appState.navigation.navigate).toHaveBeenCalledWith('settings', { tab: 'status' });
    expect(rpcUpdate.openLatest).not.toHaveBeenCalled();
  });

  it.each([
    ['found at launch', true, 1],
    ['found after a click', false, 0],
  ])(
    'on a renderer start, toasts a failure %s that main already holds',
    async (_label, installFailedAtLaunch, toasts) => {
      rpcUpdate.getState.mockResolvedValue({
        success: true,
        data: {
          status: 'install-failed',
          currentVersion: '1.0.0',
          availableVersion: '2.0.0',
          error: message,
          installFailedAtLaunch,
        },
      });
      const store = new UpdateStore();
      store.start();

      await vi.waitFor(() => expect(store.state.status).toBe('install-failed'));
      expect(store.availableVersion).toBe('2.0.0');
      expect(toast.error).toHaveBeenCalledTimes(toasts);
    }
  );

  it('keeps the reason main gave when mapping its state', () => {
    expect(
      mainStateToRendererState({
        status: 'install-failed',
        currentVersion: '1.0.0',
        error: message,
      })
    ).toEqual({ status: 'install-failed', message });
  });
});

describe('a check that the user starts', () => {
  const message = "Version 2.0.0 didn't install: Switch Console restarted on version 1.0.0.";
  const failed = { version: '2.0.0', message, foundAtLaunch: false };

  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
    localStorage.clear();
  });

  it.each([
    ['fails', () => Promise.resolve({ success: false, error: 'getaddrinfo ENOTFOUND' })],
    ['finds nothing', () => Promise.resolve({ success: true, result: null })],
    ['gets no answer', () => Promise.resolve(null)],
    ['rejects', () => Promise.reject(new Error('IPC closed'))],
  ])('keeps install-failed when the check %s', async (_label, answer) => {
    const store = await startedStore();
    emit(updateInstallFailedEvent, failed);
    rpcUpdate.check.mockImplementation(answer);

    await store.check();

    expect(rpcUpdate.check).toHaveBeenCalled();
    expect(store.state).toEqual({ status: 'install-failed', message });
  });

  it('keeps showing install-failed while the check runs', async () => {
    // The card and its "Download manually" button must not go away while the
    // check is pending, not only after it ends.
    const store = await startedStore();
    emit(updateInstallFailedEvent, failed);
    let duringCheck: unknown;
    rpcUpdate.check.mockImplementation(async () => {
      emit(updateCheckingEvent);
      duringCheck = { ...store.state };
      return { success: true, result: { version: '2.0.0' } };
    });

    await store.check();

    expect(duringCheck).toEqual({ status: 'install-failed', message });
  });

  it('keeps install-failed when main sends it again during the check', async () => {
    const store = await startedStore();
    emit(updateInstallFailedEvent, failed);
    rpcUpdate.check.mockImplementation(async () => {
      emit(updateCheckingEvent);
      emit(updateInstallFailedEvent, failed);
      return { success: false, error: 'getaddrinfo ENOTFOUND' };
    });

    await store.check();

    expect(store.state).toEqual({ status: 'install-failed', message });
  });

  it.each([
    ['the store', (store: InstanceType<typeof UpdateStore>) => store.check()],
    ['the menu', () => emit(menuCheckForUpdatesChannel)],
  ])('does not ask main to check during an install, from %s', async (_label, startCheck) => {
    const store = await startedStore();
    emit(updateInstallingEvent);

    await startCheck(store);

    expect(rpcUpdate.check).not.toHaveBeenCalled();
    expect(store.state).toEqual({ status: 'installing' });
  });

  it('keeps installing when an earlier check finds nothing', async () => {
    const store = await startedStore();
    rpcUpdate.check.mockImplementation(async () => {
      emit(updateInstallingEvent);
      return { success: true, result: null };
    });

    await store.check();

    expect(store.state).toEqual({ status: 'installing' });
  });
});

describe('the release notes link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks main to open the page, since only main knows a version is made up', async () => {
    rpcUpdate.openReleaseNotes.mockResolvedValue({ success: true });

    await new UpdateStore().openReleasePage();

    expect(rpcUpdate.openReleaseNotes).toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('says so when the page could not be opened', async () => {
    rpcUpdate.openReleaseNotes.mockResolvedValue({ success: false, error: 'no browser' });

    await new UpdateStore().openReleasePage();

    expect(toast.error).toHaveBeenCalledWith('Could not open the release page', {
      description: 'no browser',
    });
  });

  it('says so when "Download manually" could not open the page', async () => {
    // Main does not quit in this case, so without a toast nothing happens.
    rpcUpdate.openLatest.mockResolvedValue({ success: false, error: 'no browser' });

    await new UpdateStore().openLatest();

    expect(toast.error).toHaveBeenCalledWith('Could not open the download page', {
      description: 'no browser',
    });
  });
});
