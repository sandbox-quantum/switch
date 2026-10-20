import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  updateAvailableEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateInstallingEvent,
  updateNotAvailableEvent,
} from '@shared/events/updateEvents';

const handlers = vi.hoisted(() => new Map<unknown, (payload?: unknown) => void>());
const toast = vi.hoisted(() => Object.assign(vi.fn(), { dismiss: vi.fn(), error: vi.fn() }));

vi.mock('sonner', () => ({ toast }));
vi.mock('@renderer/lib/components/update-toast-action-label', () => ({
  createUpdateToastActionLabel: () => 'Update',
}));
vi.mock('@renderer/lib/open-external', () => ({ openExternalUrl: vi.fn() }));
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
    update: {
      getState: () => Promise.resolve({ success: false }),
      check: () => Promise.resolve(null),
    },
  },
}));

const stored = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => stored.set(key, value),
  removeItem: (key: string) => stored.delete(key),
  clear: () => stored.clear(),
});

const { UPDATE_AVAILABLE_TOAST_ID, UpdateStore } = await import('./update-store');

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
