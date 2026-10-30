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
  findInstallBlocker: vi.fn(),
  /** The handover marker, which outlives the process in the real thing. */
  pending: { target: null as string | null, legacy: false },
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
    set: async (target: string) => {
      h.pending.target = target;
    },
    clear: async () => {
      h.pending.target = null;
      h.pending.legacy = false;
    },
    take: async () => {
      const { target, legacy } = h.pending;
      h.pending.target = null;
      h.pending.legacy = false;
      return target !== null || legacy ? { targetVersion: target } : null;
    },
  },
}));
// The real check reads the running bundle off disk; install-preflight.test.ts
// covers it against real folders.
vi.mock('./install-preflight', () => ({
  macAppBundlePath: () => '/Applications/Switch Console.app',
  findInstallBlocker: h.findInstallBlocker,
}));
vi.mock('@main/core/app/utils', () => ({ resolveAppVersion: async () => '1.2.3' }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { EventEmitter } from 'node:events';
import { app } from 'electron';
import { events } from '@main/lib/events';
import type * as AppIdentity from '@shared/app-identity';
import { updateInstallFailedEvent } from '@shared/events/updateEvents';
import { updateService } from './update-service';

/** The app going down for the installer, as the service observes it. */
function quitApp(): void {
  (app as unknown as EventEmitter).emit('before-quit');
}

function installEvents(): unknown[] {
  return h.trackEvent.mock.calls.filter(([name]) => name === 'update_install_started');
}

function installFailures(): unknown[] {
  return vi.mocked(events.emit).mock.calls.filter(([event]) => event === updateInstallFailedEvent);
}

/**
 * Drive the service to "ready to install" through its own listeners: that state
 * is not reachable any other way, and going round them would test a state the
 * app cannot be in. The bundle check that precedes it is asynchronous.
 */
async function downloadVersion(version: string): Promise<void> {
  h.handlers.get('update-not-available')?.();
  h.handlers.get('update-available')?.({ version });
  h.handlers.get('update-downloaded')?.({ version });
  await vi.advanceTimersByTimeAsync(0);
}

/** Run a test as if on macOS, the one platform whose bundle is checked. */
function onMac(): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  return () => {
    if (original) Object.defineProperty(process, 'platform', original);
  };
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
  vi.mocked(events.emit).mockClear();
  h.findInstallBlocker.mockReset();
  h.findInstallBlocker.mockResolvedValue(null);
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
  beforeEach(async () => {
    await downloadVersion('1.3.0');
    h.quitAndInstall.mockReset();
    h.trackEvent.mockClear();
    vi.mocked(events.emit).mockClear();
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
    // The version, so the next launch can tell an install from a relaunch.
    expect(h.pending.target).toBe('1.3.0');
  });

  it('reports a handover that threw, and reports only that', () => {
    h.quitAndInstall.mockImplementation(() => {
      throw new Error('installer is missing');
    });

    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(updateService.getState().error).toContain('installer is missing');
  });

  it('shows an installer error that arrives after the handover', () => {
    // Squirrel.Mac's failure to replace the bundle reaches the updater's error
    // listener while the app is still on "installing".
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    h.handlers.get('error')?.(new Error('Could not write the app bundle'));

    expect(updateService.getState()).toMatchObject({
      status: 'install-failed',
      availableVersion: '1.3.0',
    });
    expect(installFailures()).toEqual([
      [
        updateInstallFailedEvent,
        {
          version: '1.3.0',
          message: "Version 1.3.0 didn't install: Could not write the app bundle",
          foundAtLaunch: false,
        },
      ],
    ]);
    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    expect(h.pending.target).toBeNull();

    // The guard that would have fired later has nothing left to report.
    vi.advanceTimersByTime(2 * 60 * 1000);
    expect(installEvents()).toHaveLength(1);
    expect(installFailures()).toHaveLength(1);
  });

  it('reports an install that never left as one failure', () => {
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(2 * 60 * 1000);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    // Not back to "ready to install": restarting again would fail the same way.
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(installFailures()).toHaveLength(1);
  });

  it('adds nothing when the app quits long after an attempt was written off', () => {
    updateService.quitAndInstall();
    vi.advanceTimersByTime(250);
    vi.advanceTimersByTime(2 * 60 * 1000);
    quitApp();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    // An attempt that unwound leaves nothing for the next launch to find, or it
    // would be reported as a success as well as a failure.
    expect(h.pending.target).toBeNull();
  });
});

describe('a copy of the app that cannot update itself', () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = onMac();
  });

  afterEach(() => {
    restorePlatform();
  });

  it('is never offered a restart', async () => {
    h.findInstallBlocker.mockResolvedValue({
      reason: 'not_owned',
      bundlePath: '/Applications/Switch Console.app',
    });

    await downloadVersion('1.4.0');

    expect(h.findInstallBlocker).toHaveBeenCalledWith(
      '/Applications/Switch Console.app',
      expect.any(Number)
    );
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(updateService.getState().error).toMatch(/belongs to another account/);
    expect(() => updateService.quitAndInstall()).toThrow(/install-failed/);
    expect(h.quitAndInstall).not.toHaveBeenCalled();
  });

  it('names the folder it cannot write to', async () => {
    h.findInstallBlocker.mockResolvedValue({
      reason: 'not_writable',
      bundlePath: '/Applications/Switch Console.app',
      deniedPath: '/Applications',
    });

    await downloadVersion('1.4.0');

    expect(updateService.getState().error).toContain("can't write to /Applications");
  });

  it('is told to move a translocated copy', async () => {
    h.findInstallBlocker.mockResolvedValue({
      reason: 'translocated',
      bundlePath: '/private/var/folders/x/AppTranslocation/1/d/Switch Console.app',
    });

    await downloadVersion('1.4.0');

    expect(updateService.getState().error).toMatch(/Applications folder/);
  });

  it('is offered a restart when nothing is in the way', async () => {
    await downloadVersion('1.4.0');

    expect(updateService.getState()).toMatchObject({ status: 'downloaded' });
  });

  it('links the release notes of the version on offer', async () => {
    await downloadVersion('1.4.0');

    await expect(updateService.releaseNotesUrl()).resolves.toBe(
      'https://github.com/sandbox-quantum/switch/releases/tag/switch-console-v1.4.0'
    );
  });
});

describe('the launch after an install', () => {
  beforeEach(() => {
    vi.resetModules();
    h.trackEvent.mockClear();
  });

  it('reports the handover the previous run wrote down', async () => {
    h.pending.target = '1.2.3';
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'success' }]]);
    expect(restarted.getState()).toMatchObject({ status: 'idle' });
    // Taken, not just read: a launch is counted once, and a user who never
    // updates again does not report this install on every start from here on.
    expect(h.pending.target).toBeNull();
  });

  it('counts a marker from a build that recorded no version as a success', async () => {
    h.pending.legacy = true;
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'success' }]]);
    expect(h.pending.legacy).toBe(false);
  });

  it('says the update did not install when the app came back on the old version', async () => {
    // Squirrel.Mac can take the app down, fail to replace the bundle, and
    // relaunch the old one with nothing on screen.
    h.pending.target = '1.3.0';
    const { updateService: restarted } = await import('./update-service');
    const { events: restartedEvents } = await import('@main/lib/events');
    const { updateInstallFailedEvent: failedEvent } = await import('@shared/events/updateEvents');
    vi.mocked(restartedEvents.emit).mockClear();
    await restarted.initialize();
    restarted.dispose();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    expect(restarted.getState()).toMatchObject({
      status: 'install-failed',
      availableVersion: '1.3.0',
      error: "Version 1.3.0 didn't install: Switch Console restarted on version 1.2.3.",
    });
    expect(restartedEvents.emit).toHaveBeenCalledWith(failedEvent, {
      version: '1.3.0',
      message: expect.stringContaining('1.3.0'),
      foundAtLaunch: true,
    });
    expect(restarted.getState().installFailedAtLaunch).toBe(true);

    // The check that follows finds the same release. Offering it again would
    // only fail the same way, so the failure stays on screen.
    h.checkForUpdatesAndNotify.mockImplementation(async () => {
      h.handlers.get('checking-for-update')?.();
      h.handlers.get('update-available')?.({ version: '1.3.0' });
      return { isUpdateAvailable: true, updateInfo: { version: '1.3.0' } };
    });
    // A check that fails in between does not replace the reason.
    h.checkForUpdatesAndNotify.mockImplementationOnce(async () => {
      h.handlers.get('error')?.(new Error('getaddrinfo ENOTFOUND github.com'));
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });
    await expect(restarted.checkForUpdates('scheduled')).rejects.toThrow('ENOTFOUND');
    vi.mocked(restartedEvents.emit).mockClear();
    await restarted.checkForUpdates('scheduled');
    // Shown again, but no longer news: no second toast an hour later.
    expect(restartedEvents.emit).toHaveBeenCalledWith(failedEvent, {
      version: '1.3.0',
      message: expect.stringContaining('1.3.0'),
      foundAtLaunch: false,
    });
    expect(restarted.getState().installFailedAtLaunch).toBe(false);
    expect(restarted.getState()).toMatchObject({
      status: 'install-failed',
      error: "Version 1.3.0 didn't install: Switch Console restarted on version 1.2.3.",
    });

    // A newer release is a new chance, and is offered as usual.
    h.checkForUpdatesAndNotify.mockImplementation(async () => {
      h.handlers.get('update-available')?.({ version: '1.4.0' });
      return { isUpdateAvailable: true, updateInfo: { version: '1.4.0' } };
    });
    await restarted.checkForUpdates('scheduled');
    expect(restarted.getState()).toMatchObject({ status: 'available', availableVersion: '1.4.0' });
    restarted.dispose();
    h.checkForUpdatesAndNotify.mockReset();
  });

  it('reports nothing on an ordinary launch', async () => {
    h.pending.target = null;
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([]);
  });
});

describe('a canary build', () => {
  afterEach(() => {
    vi.doUnmock('@shared/app-identity');
    vi.doUnmock('./canary-feed');
  });

  it('reports a failed release lookup as an update error', async () => {
    // The lookup runs before the updater, so the updater's error listener never
    // hears about it — and a scheduled check has no caller to show the error.
    vi.resetModules();
    vi.doMock('@shared/app-identity', async (importOriginal) => ({
      ...(await importOriginal<typeof AppIdentity>()),
      IS_CANARY: true,
    }));
    vi.doMock('./canary-feed', () => ({
      resolveCanaryFeedUrl: async () => {
        throw new Error('GitHub API returned 403');
      },
    }));
    const { events } = await import('@main/lib/events');
    const { updateErrorEvent } = await import('@shared/events/updateEvents');
    const { updateService: canary } = await import('./update-service');
    await canary.initialize();
    canary.dispose();
    vi.mocked(events.emit).mockClear();
    h.checkForUpdatesAndNotify.mockClear();

    await expect(canary.checkForUpdates('scheduled')).rejects.toThrow('403');

    expect(h.checkForUpdatesAndNotify).not.toHaveBeenCalled();
    expect(canary.getState()).toMatchObject({ status: 'error' });
    expect(canary.getState().error).toContain('403');
    expect(events.emit).toHaveBeenCalledWith(updateErrorEvent, {
      message: expect.stringContaining('403'),
    });
    canary.dispose();
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

    // The harness's version has no release, so its release notes are the
    // newest real release on the channel.
    await expect(harnessed.releaseNotesUrl()).resolves.toBe(
      'https://github.com/sandbox-quantum/switch/releases/latest'
    );
    harnessed.dispose();
  });
});
