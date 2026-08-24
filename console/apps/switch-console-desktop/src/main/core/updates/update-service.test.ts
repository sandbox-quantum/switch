import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What a check and an install attempt report.
 *
 * Both are answered from the updater's own results rather than from the call
 * returning: a check that finds nothing still comes back with a release
 * attached, and an install that fails does so minutes after the app handed over.
 */

const h = vi.hoisted(() => ({
  handlers: new Map<string, (arg?: unknown) => void>(),
  setFeedURL: vi.fn(),
  checkForUpdatesAndNotify: vi.fn(),
  downloadUpdate: vi.fn(),
  quitAndInstall: vi.fn(),
  trackEvent: vi.fn(),
  /** The handover marker, which outlives the process in the real thing. */
  pending: { handover: false },
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: new EventEmitter() };
});

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: {
      on: (event: string, fn: (arg?: unknown) => void) => h.handlers.set(event, fn),
      setFeedURL: h.setFeedURL,
      checkForUpdatesAndNotify: h.checkForUpdatesAndNotify,
      downloadUpdate: h.downloadUpdate,
      quitAndInstall: h.quitAndInstall,
    },
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
// Backed by the database in the real thing, which this project has no Electron
// app to open.
vi.mock('./pending-install', () => ({
  pendingInstall: {
    set: async () => {
      h.pending.handover = true;
    },
    clear: async () => {
      h.pending.handover = false;
    },
    take: async () => {
      const held = h.pending.handover;
      h.pending.handover = false;
      return held;
    },
  },
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: async () => '1.2.3' }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { EventEmitter } from 'node:events';
import { app } from 'electron';
import { updateService } from './update-service';

/** The app going down for the installer, as the service observes it. */
function quitApp(): void {
  (app as unknown as EventEmitter).emit('before-quit');
}

function installEvents(): unknown[] {
  return h.trackEvent.mock.calls.filter(([name]) => name === 'update_install_started');
}

beforeAll(async () => {
  vi.useFakeTimers();
  // The updater is inert outside a packaged build, and the dev harness is the
  // path that stands in for it there — so the real one has to be asked for.
  vi.stubEnv('DEV', false);
  await updateService.initialize();
  // Drop the startup check it schedules; every test here drives its own.
  updateService.dispose();
});

afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  h.trackEvent.mockClear();
});

describe('what a check reports', () => {
  it('reports a check that found nothing as up to date', async () => {
    // The updater answers its not-available branch with the release it just
    // compared this build against, so an `updateInfo` is present either way.
    h.checkForUpdatesAndNotify.mockResolvedValue({
      isUpdateAvailable: false,
      versionInfo: { version: '1.2.3' },
      updateInfo: { version: '1.2.3' },
    });

    await expect(updateService.checkForUpdates('scheduled')).resolves.toBeNull();

    expect(h.trackEvent).toHaveBeenCalledWith('update_checked', {
      trigger: 'scheduled',
      result: 'up_to_date',
    });
  });

  it('reports a check that found one as available', async () => {
    h.checkForUpdatesAndNotify.mockResolvedValue({
      isUpdateAvailable: true,
      versionInfo: { version: '1.3.0' },
      updateInfo: { version: '1.3.0' },
    });

    await expect(updateService.checkForUpdates('user')).resolves.toMatchObject({
      version: '1.3.0',
    });

    expect(h.trackEvent).toHaveBeenCalledWith('update_checked', {
      trigger: 'user',
      result: 'available',
    });
  });

  it('reports a check that could not run as failed', async () => {
    h.checkForUpdatesAndNotify.mockRejectedValue(new Error('HTTP 503'));

    await expect(updateService.checkForUpdates('startup')).rejects.toThrow();

    expect(h.trackEvent).toHaveBeenCalledWith('update_checked', {
      trigger: 'startup',
      result: 'failed',
    });
  });
});

describe('what one install attempt reports', () => {
  beforeEach(() => {
    // Through the service's own listeners: "downloaded" is not reachable any
    // other way, and going round them would test a state the app cannot be in.
    h.handlers.get('update-available')?.({ version: '1.3.0' });
    h.handlers.get('update-downloaded')?.({ version: '1.3.0' });
    h.quitAndInstall.mockReset();
    h.trackEvent.mockClear();
  });

  afterEach(() => {
    // Unwind an attempt that is still open, so the next test is not refused as a
    // duplicate. The latch means this adds nothing to what was already reported.
    vi.advanceTimersByTime(3 * 60 * 1000);
  });

  it('says nothing about a handover from inside the process it ends', () => {
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    quitApp();

    // The shutdown handler calls `app.exit`, and a send is a consent read and an
    // HTTP post — neither survives it. What the handover leaves behind is the
    // marker, which the next launch reports from.
    expect(h.quitAndInstall).toHaveBeenCalled();
    expect(installEvents()).toEqual([]);
    expect(h.pending.handover).toBe(true);
  });

  it('reports a handover that threw, and reports only that', () => {
    h.quitAndInstall.mockImplementation(() => {
      throw new Error('installer is missing');
    });

    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
  });

  it('reports an install that never left as one failure', () => {
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(2 * 60 * 1000);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
  });

  it('adds nothing when the app quits long after an attempt was written off', () => {
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(2 * 60 * 1000);
    quitApp();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    // An attempt that unwound leaves nothing for the next launch to find, or it
    // would be reported as a success as well as a failure.
    expect(h.pending.handover).toBe(false);
  });
});

describe('the launch after an install', () => {
  beforeEach(() => {
    vi.resetModules();
    h.trackEvent.mockClear();
  });

  it('reports the handover the previous run wrote down', async () => {
    h.pending.handover = true;
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'success' }]]);
    // Taken, not just read: a launch is counted once, and a user who never
    // updates again does not report this install on every start from here on.
    expect(h.pending.handover).toBe(false);
  });

  it('reports nothing on an ordinary launch', async () => {
    h.pending.handover = false;
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([]);
  });
});

describe('the dev harness', () => {
  it('reports one event for a simulated install, not two', async () => {
    // A dev build has no binary to restart into, so the harness always unwinds.
    // That is one attempt and one outcome, the same as any other.
    vi.resetModules();
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCHDASH_FAKE_UPDATE', 'available');
    vi.stubEnv('SWITCHDASH_FAKE_UPDATE_MS', '100');

    const { updateService: harnessed } = await import('./update-service');
    await harnessed.initialize();

    await vi.advanceTimersByTimeAsync(3_000);
    const download = harnessed.downloadUpdate();
    await vi.advanceTimersByTimeAsync(3_000);
    await download;

    h.trackEvent.mockClear();
    harnessed.quitAndInstall();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    harnessed.dispose();
  });
});
