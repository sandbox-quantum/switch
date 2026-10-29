import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  updateAvailableEvent,
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
  createUpdateToastActionLabel: () => 'Update',
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

  it('says so, and offers the manual download', () => {
    const store = new UpdateStore();
    store.start();

    emit(updateInstallFailedEvent, { version: '2.0.0', message });

    expect(store.state).toEqual({ status: 'install-failed', message });
    expect(store.latestVersion).toBe('2.0.0');
    expect(toast.error).toHaveBeenCalledWith(
      "Update didn't install",
      expect.objectContaining({ id: UPDATE_INSTALL_FAILED_TOAST_ID, description: message })
    );

    const [, options] = toast.error.mock.calls[0] as [string, { action: { onClick(): void } }];
    options.action.onClick();
    expect(rpcUpdate.openLatest).toHaveBeenCalled();
  });

  it('is told on the launch that found it, before any window was listening', async () => {
    rpcUpdate.getState.mockResolvedValue({
      success: true,
      data: {
        status: 'install-failed',
        currentVersion: '1.0.0',
        availableVersion: '2.0.0',
        error: message,
      },
    });
    const store = new UpdateStore();
    store.start();

    await vi.waitFor(() => expect(store.state.status).toBe('install-failed'));
    expect(store.availableVersion).toBe('2.0.0');
    expect(toast.error).toHaveBeenCalledWith(
      "Update didn't install",
      expect.objectContaining({ description: message })
    );
  });

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
});
