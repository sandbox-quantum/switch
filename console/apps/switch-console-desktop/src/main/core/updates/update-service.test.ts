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
  isTranslocated: vi.fn(),
  /** The flags the service sets on the updater. */
  updater: { autoInstallOnAppQuit: true },
  /** The handover marker, which outlives the process in the real thing. */
  pending: {
    target: null as string | null,
    from: null as string | null,
    legacy: false,
    failWrite: false,
    /** While set, the marker write does not settle until this promise does. */
    pendingWrite: null as Promise<void> | null,
  },
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { app: new EventEmitter() };
});

vi.mock('electron-updater', () => ({
  default: {
    autoUpdater: Object.assign(h.updater, {
      on: (event: string, fn: (arg?: unknown) => void) => h.handlers.set(event, fn),
      setFeedURL: h.setFeedURL,
      checkForUpdatesAndNotify: h.checkForUpdatesAndNotify,
      downloadUpdate: h.downloadUpdate,
      quitAndInstall: h.quitAndInstall,
    }),
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
// Backed by the database in the real thing, which this project has no Electron
// app to open.
vi.mock('./pending-install', () => ({
  pendingInstall: {
    set: async (target: string, from: string) => {
      if (h.pending.pendingWrite) await h.pending.pendingWrite;
      if (h.pending.failWrite) throw new Error('SQLITE_FULL: database or disk is full');
      h.pending.target = target;
      h.pending.from = from;
    },
    clear: async () => {
      h.pending.target = null;
      h.pending.from = null;
      h.pending.legacy = false;
    },
    take: async () => {
      const { target, from, legacy } = h.pending;
      h.pending.target = null;
      h.pending.from = null;
      h.pending.legacy = false;
      return target !== null || legacy ? { targetVersion: target, fromVersion: from } : null;
    },
  },
}));
// The real check reads the path of the running executable;
// install-preflight.test.ts covers it.
vi.mock('./install-preflight', () => ({ isTranslocated: h.isTranslocated }));
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
 * app cannot be in.
 */
async function downloadVersion(version: string): Promise<void> {
  h.handlers.get('update-not-available')?.();
  h.handlers.get('update-available')?.({ version });
  h.handlers.get('update-downloaded')?.({ version });
  await vi.advanceTimersByTimeAsync(0);
}

/** Drive the service to "available", the state a download starts from. */
function offerVersion(version: string): void {
  h.handlers.get('update-not-available')?.();
  h.handlers.get('update-available')?.({ version });
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
  h.isTranslocated.mockReset();
  h.isTranslocated.mockReturnValue(false);
  h.pending.failWrite = false;
  h.pending.pendingWrite = null;
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

describe('what a download reports', () => {
  beforeEach(() => {
    h.handlers.get('update-available')?.({ version: '1.3.0' });
    h.trackEvent.mockClear();
  });

  it('reports the press, then how the download ended', async () => {
    h.downloadUpdate.mockResolvedValueOnce(undefined);

    await updateService.downloadUpdate();

    expect(
      h.trackEvent.mock.calls.filter(([name]) => String(name).startsWith('update_download'))
    ).toEqual([
      ['update_download_started', {}],
      ['update_downloaded', { outcome: 'success' }],
    ]);
  });

  it('reports the press even when the download then fails', async () => {
    h.downloadUpdate.mockRejectedValueOnce(new Error('connection reset'));

    await expect(updateService.downloadUpdate()).rejects.toThrow('connection reset');

    expect(
      h.trackEvent.mock.calls.filter(([name]) => String(name).startsWith('update_download'))
    ).toEqual([
      ['update_download_started', {}],
      ['update_downloaded', { outcome: 'failure' }],
    ]);
  });
});

describe('what one install attempt reports', () => {
  beforeEach(async () => {
    await downloadVersion('1.3.0');
    h.quitAndInstall.mockReset();
    h.trackEvent.mockClear();
    vi.mocked(events.emit).mockClear();
  });

  afterEach(async () => {
    // Unwind an attempt that is still open, so the next test is not refused as a
    // duplicate. The latch means this adds nothing to what was already reported.
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
  });

  it('says nothing about a handover from inside the process it ends', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);
    quitApp();

    // The shutdown handler calls `app.exit`, and a send is a consent read and an
    // HTTP post — neither survives it. What the handover leaves behind is the
    // marker, which the next launch reports from.
    expect(h.quitAndInstall).toHaveBeenCalled();
    expect(installEvents()).toEqual([]);
    // The version, so the next launch can tell an install from a relaunch.
    expect(h.pending.target).toBe('1.3.0');
  });

  it('reports a handover that threw, and reports only that', async () => {
    h.quitAndInstall.mockImplementation(() => {
      throw new Error('installer is missing');
    });

    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(updateService.getState().error).toContain('installer is missing');
  });

  it('shows an installer error that arrives after the handover', async () => {
    // Squirrel.Mac's failure to replace the bundle reaches the updater's error
    // listener while the app is still on "installing".
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);
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
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(installEvents()).toHaveLength(1);
    expect(installFailures()).toHaveLength(1);
  });

  it('reports an install that never left as one failure', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    // Not back to "ready to install": restarting again would fail the same way.
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(installFailures()).toHaveLength(1);
  });

  it('does not hand over after an installer error has already ended the attempt', async () => {
    updateService.quitAndInstall();
    // An error inside the 250 ms before the handover.
    await vi.advanceTimersByTimeAsync(100);
    h.handlers.get('error')?.(new Error('Could not write the app bundle'));
    await vi.advanceTimersByTimeAsync(150);

    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    // The panel says the update didn't install, so the app must not then go
    // down for the installer anyway.
    expect(h.quitAndInstall).not.toHaveBeenCalled();
  });

  it('refuses a second restart while one is in progress', async () => {
    updateService.quitAndInstall();
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);

    expect(h.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('adds nothing when the app quits long after an attempt was written off', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    quitApp();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    // An attempt that unwound leaves nothing for the next launch to find, or it
    // would be reported as a success as well as a failure.
    expect(h.pending.target).toBeNull();
  });
  it('does not hand over when the marker cannot be written', async () => {
    h.pending.failWrite = true;

    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);

    expect(h.quitAndInstall).not.toHaveBeenCalled();
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(updateService.getState().error).toContain('could not save the update');
    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
  });

  it('waits for the marker write before the handover', async () => {
    let finishWrite = () => {};
    h.pending.pendingWrite = new Promise((resolve) => {
      finishWrite = resolve;
    });

    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.quitAndInstall).not.toHaveBeenCalled();

    finishWrite();
    await vi.advanceTimersByTimeAsync(250);
    expect(h.quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it('does not hand over after dispose', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(100);
    updateService.dispose();
    await vi.advanceTimersByTimeAsync(250);
    const handovers = h.quitAndInstall.mock.calls.length;
    // Dispose also cleared the restart guard, so only an error can end the
    // attempt that the next test would otherwise see as still open.
    h.handlers.get('error')?.(new Error('Could not write the app bundle'));

    expect(handovers).toBe(0);
  });

  it('records the version that handed over next to the target', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);

    expect(h.pending).toMatchObject({ target: '1.3.0', from: '1.2.3' });
  });

  it('does not check for updates during an install', async () => {
    // An error from that check would read as an installer error.
    h.checkForUpdatesAndNotify.mockClear();
    updateService.quitAndInstall();

    await expect(updateService.checkForUpdates('scheduled')).resolves.toBeNull();
    expect(h.checkForUpdatesAndNotify).not.toHaveBeenCalled();
  });

  it('checks again on schedule after an install that failed', async () => {
    // A scheduled check that fires during the install is skipped, and the
    // failed attempt must re-arm the timer, or a fixed release is never offered.
    // Clear the timer that earlier checks left, so only the attempt can arm one.
    updateService.dispose();
    updateService.quitAndInstall();
    await expect(updateService.checkForUpdates('scheduled')).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(250);
    h.handlers.get('error')?.(new Error('Could not write the app bundle'));
    h.checkForUpdatesAndNotify.mockReset();
    h.checkForUpdatesAndNotify.mockResolvedValue({ isUpdateAvailable: false });

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(h.checkForUpdatesAndNotify).toHaveBeenCalled();
    updateService.dispose();
    h.checkForUpdatesAndNotify.mockReset();
  });

  it('stops installing on quit after a failure, until a newer version is downloaded', async () => {
    updateService.quitAndInstall();
    await vi.advanceTimersByTimeAsync(250);
    h.handlers.get('error')?.(new Error('Could not write the app bundle'));

    // "Download manually" quits the app, and that quit must not start a
    // second install that could fail without a word.
    expect(h.updater.autoInstallOnAppQuit).toBe(false);

    // The installer on disk is still the one that failed.
    h.handlers.get('update-available')?.({ version: '1.4.0' });
    expect(h.updater.autoInstallOnAppQuit).toBe(false);

    h.handlers.get('update-downloaded')?.({ version: '1.4.0' });
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
  });
});

describe('the translocation check', () => {
  let restorePlatform: () => void;

  beforeEach(() => {
    restorePlatform = onMac();
    h.downloadUpdate.mockReset();
    h.downloadUpdate.mockResolvedValue([]);
  });

  afterEach(() => {
    restorePlatform();
  });

  it('stops a translocated copy before the download', async () => {
    h.isTranslocated.mockReturnValue(true);
    offerVersion('1.4.0');

    await updateService.downloadUpdate();

    expect(h.downloadUpdate).not.toHaveBeenCalled();
    expect(updateService.getState()).toMatchObject({ status: 'install-failed' });
    expect(updateService.getState().error).toMatch(/Applications folder/);
    expect(() => updateService.quitAndInstall()).toThrow(/install-failed/);
  });

  it('downloads for a copy that is not translocated', async () => {
    offerVersion('1.5.0');

    await updateService.downloadUpdate();

    expect(h.isTranslocated).toHaveBeenCalledWith(process.execPath);
    expect(h.downloadUpdate).toHaveBeenCalled();
  });

  it('is not run off macOS, because only macOS replaces the running bundle', async () => {
    restorePlatform();
    const original = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      offerVersion('1.6.0');
      await updateService.downloadUpdate();
    } finally {
      if (original) Object.defineProperty(process, 'platform', original);
      restorePlatform = onMac();
    }

    expect(h.isTranslocated).not.toHaveBeenCalled();
    expect(h.downloadUpdate).toHaveBeenCalled();
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
    h.pending.from = '1.2.2';
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
    h.pending.from = '1.2.3';
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
    // "Download manually" quits the app, and that quit must not start a second
    // install. The updater is set up after the failure is found.
    expect(h.updater.autoInstallOnAppQuit).toBe(false);

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
    expect(restarted.getState()).toMatchObject({ status: 'install-failed' });
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

  it('shows no failure for a marker from a build that recorded no version', async () => {
    h.pending.legacy = true;
    const { updateService: restarted } = await import('./update-service');
    const { events: restartedEvents } = await import('@main/lib/events');
    vi.mocked(restartedEvents.emit).mockClear();
    await restarted.initialize();
    restarted.dispose();

    expect(restarted.getState()).toMatchObject({ status: 'idle' });
    expect(restarted.getState().installFailedAtLaunch).toBeUndefined();
    expect(restartedEvents.emit).not.toHaveBeenCalled();
  });

  it('counts a launch on a version other than the one that handed over as a success', async () => {
    // The handover to 1.3.0 did not take, and the user then installed 1.2.3 by
    // hand. An install happened, so there is nothing to show.
    h.pending.target = '1.3.0';
    h.pending.from = '1.2.0';
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();
    restarted.dispose();

    expect(installEvents()).toEqual([['update_install_started', { outcome: 'success' }]]);
    expect(restarted.getState()).toMatchObject({ status: 'idle' });
  });

  it('reports nothing on an ordinary launch', async () => {
    h.pending.target = null;
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();

    expect(installEvents()).toEqual([]);
  });
});

describe('a failure that is still on screen', () => {
  async function launchAfterSilentFailure() {
    vi.resetModules();
    h.pending.target = '1.3.0';
    h.pending.from = '1.2.3';
    const { updateService: restarted } = await import('./update-service');
    await restarted.initialize();
    restarted.dispose();
    h.checkForUpdatesAndNotify.mockImplementationOnce(async () => {
      h.handlers.get('error')?.(new Error('getaddrinfo ENOTFOUND github.com'));
      throw new Error('getaddrinfo ENOTFOUND github.com');
    });
    await expect(restarted.checkForUpdates('scheduled')).rejects.toThrow('ENOTFOUND');
    restarted.dispose();
    return restarted;
  }

  afterEach(() => {
    h.checkForUpdatesAndNotify.mockReset();
  });

  it('stays on screen while a check runs', async () => {
    vi.resetModules();
    h.pending.target = '1.3.0';
    h.pending.from = '1.2.3';
    const { updateService: restarted } = await import('./update-service');
    const { events: restartedEvents } = await import('@main/lib/events');
    const { updateCheckingEvent: checkingEvent } = await import('@shared/events/updateEvents');
    await restarted.initialize();
    restarted.dispose();
    let duringCheck: string | undefined;
    h.checkForUpdatesAndNotify.mockImplementationOnce(async () => {
      h.handlers.get('checking-for-update')?.();
      duringCheck = restarted.getState().status;
      return { isUpdateAvailable: false };
    });

    await restarted.checkForUpdates('user');
    restarted.dispose();

    expect(duringCheck).toBe('install-failed');
    expect(restartedEvents.emit).not.toHaveBeenCalledWith(checkingEvent, undefined);
  });

  it('is not replaced by a check that fails', async () => {
    const restarted = await launchAfterSilentFailure();

    // The renderer shows "Try again" for `error`, which downloads the version
    // that already failed to install.
    expect(restarted.getState()).toMatchObject({
      status: 'install-failed',
      error: "Version 1.3.0 didn't install: Switch Console restarted on version 1.2.3.",
    });
  });

  it('is not downloaded again after a check fails', async () => {
    const restarted = await launchAfterSilentFailure();
    h.downloadUpdate.mockClear();

    await expect(restarted.downloadUpdate()).rejects.toThrow();
    expect(h.downloadUpdate).not.toHaveBeenCalled();
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

  it('shows a simulated installer failure as install-failed', async () => {
    vi.resetModules();
    vi.stubEnv('DEV', true);
    vi.stubEnv('SWITCHDASH_FAKE_UPDATE', 'install-error');
    vi.stubEnv('SWITCHDASH_FAKE_UPDATE_MS', '100');

    const { updateService: harnessed } = await import('./update-service');
    await harnessed.initialize();

    await vi.advanceTimersByTimeAsync(3_000);
    const download = harnessed.downloadUpdate();
    await vi.advanceTimersByTimeAsync(3_000);
    await download;
    expect(harnessed.getState()).toMatchObject({ status: 'downloaded' });

    h.trackEvent.mockClear();
    harnessed.quitAndInstall();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(harnessed.getState()).toMatchObject({ status: 'install-failed' });
    expect(harnessed.getState().error).toContain('simulated installer failure');
    expect(installEvents()).toEqual([['update_install_started', { outcome: 'failure' }]]);
    expect(h.quitAndInstall).not.toHaveBeenCalled();
    harnessed.dispose();
  });
});
