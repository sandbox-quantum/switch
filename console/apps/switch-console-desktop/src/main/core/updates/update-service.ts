import type { IDisposable, IInitializable } from '@switch-console/shared';
import _electronUpdater, {
  type ProgressInfo,
  type UpdateInfo,
  type Logger as UpdaterLogger,
} from 'electron-updater';
import { resolveAppVersion } from '@main/core/app/utils';
import type { TelemetryUpdateTrigger } from '@main/core/telemetry/events';
import { updateTriggerOf } from '@main/core/telemetry/narrow';
import { trackEvent } from '@main/core/telemetry/telemetry-service';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  IS_CANARY,
  PRODUCT_NAME,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
  UPDATE_CHANNEL,
} from '@shared/app-identity';
import {
  updateAvailableEvent,
  updateCheckingEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateErrorEvent,
  updateInstallFailedEvent,
  updateInstallingEvent,
  updateNotAvailableEvent,
  updateProgressEvent,
} from '@shared/events/updateEvents';
import { switchConsoleReleaseApiUrl } from '@shared/urls';
import { resolveCanaryFeedUrl } from './canary-feed';
import {
  FAKE_UPDATE_VERSION_ENV_VAR,
  FakeUpdateDriver,
  type UpdateSignals,
  nextFakeVersion,
  readFakeDownloadDuration,
  readFakeUpdateScenario,
} from './dev-harness';
import { type InstallBlocker, findInstallBlocker, macAppBundlePath } from './install-preflight';
import { type PendingHandover, pendingInstall } from './pending-install';
import { formatUpdaterError, sanitizeUpdaterLogArgs, updaterErrorCode } from './utils';

const { autoUpdater } = _electronUpdater;

const ALLOW_PRERELEASE = IS_CANARY;
const ALLOW_DOWNGRADE = false;
const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 30 * 1000; // 30 seconds
const INSTALL_RESTART_GUARD_TIMEOUT_MS = 2 * 60 * 1000;
/** The dev harness checks promptly — nobody wants to wait 30s to see the UI. */
const FAKE_STARTUP_DELAY_MS = 1_500;
/** Dev builds cannot restart into a new binary, so the fake install unwinds. */
const FAKE_INSTALL_ROLLBACK_MS = 3_000;

/** Why an install did not happen, as logged with `event: 'update.install'`. */
type InstallFailureCode =
  | 'installer_error'
  | 'restart_timeout'
  | 'handover_threw'
  | 'relaunched_unchanged'
  | `blocked_${InstallBlocker['reason']}`;

function describeBlocker(blocker: InstallBlocker, version: string): string {
  switch (blocker.reason) {
    case 'translocated':
      return (
        `${PRODUCT_NAME} can't install version ${version} while macOS runs it from a ` +
        'temporary location. Move it to your Applications folder and open it from there.'
      );
    case 'not_owned':
      return `${PRODUCT_NAME} can't install version ${version} because the app belongs to another account on this Mac.`;
    case 'not_writable':
      return `${PRODUCT_NAME} can't install version ${version} because it can't write to ${blocker.deniedPath}.`;
  }
}

export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'install-failed'
    | 'error';
  lastCheck?: Date;
  nextCheck?: Date;
  currentVersion: string;
  availableVersion?: string;
  updateInfo?: UpdateInfo;
  downloadProgress?: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  };
  error?: string;
  rollbackVersion?: string;
  releaseNotes?: string;
}

class UpdateService implements IInitializable, IDisposable {
  private updateState: UpdateState;
  private checkTimer?: NodeJS.Timeout;
  private currentCheckPromise: Promise<UpdateInfo | null> | null = null;
  private initialized = false;
  private active = false;
  private installRequested = false;
  private installingVersion?: string;
  /**
   * The install that last failed. Offering the same version again would only
   * fail the same way, so a check that finds it again shows the failure instead.
   */
  private installFailure?: { version: string; message: string };
  private installRestartGuardTimer?: NodeJS.Timeout;
  private fake?: FakeUpdateDriver;

  constructor() {
    this.updateState = {
      status: 'idle',
      currentVersion: 'unknown',
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.updateState.currentVersion = await resolveAppVersion();

    // Before the dev-harness branch and before `active`: the install this
    // reports belonged to the run that ended, and whether this one can check
    // for updates has no bearing on it.
    const handover = await pendingInstall.take();
    if (handover) this.reportHandover(handover);

    if (import.meta.env.DEV) {
      this.setupDevHarness();
      return;
    }

    this.setupAutoUpdater();
    this.setupEventListeners();
    this.active = true;

    log.info('AutoUpdateService initialized', {
      version: this.updateState.currentVersion,
      channel: UPDATE_CHANNEL,
    });

    this.scheduleNextCheck(STARTUP_DELAY_MS);
  }

  /**
   * Activate the dev harness when SWITCHDASH_FAKE_UPDATE names a scenario.
   * Without it the service stays inert in dev, exactly as before.
   */
  private setupDevHarness(): void {
    const scenario = readFakeUpdateScenario(process.env);
    if (!scenario) return;

    const nextVersion =
      process.env[FAKE_UPDATE_VERSION_ENV_VAR]?.trim() ||
      nextFakeVersion(this.updateState.currentVersion);

    this.fake = new FakeUpdateDriver(
      scenario,
      this.signals,
      nextVersion,
      readFakeDownloadDuration(process.env)
    );
    this.active = true;

    log.warn(
      `[dev] Update harness ACTIVE — scenario "${scenario}", fake version ${nextVersion}. ` +
        'Updates are simulated; nothing is downloaded or installed.'
    );

    this.scheduleNextCheck(FAKE_STARTUP_DELAY_MS);
  }

  /**
   * Report the install the previous run handed over. The app going down for the
   * installer is not proof it came back on the new version: on macOS a
   * Squirrel.Mac failure relaunches the old bundle without an error.
   */
  private reportHandover({ targetVersion }: PendingHandover): void {
    const current = this.updateState.currentVersion;
    if (targetVersion === null || targetVersion === current) {
      trackEvent('update_install_started', { outcome: 'success' });
      return;
    }
    trackEvent('update_install_started', { outcome: 'failure' });
    this.failInstall(
      targetVersion,
      'relaunched_unchanged',
      `Version ${targetVersion} didn't install: ${PRODUCT_NAME} restarted on version ${current}.`
    );
  }

  /** Record an install that did not happen, and show it until it is resolved. */
  private failInstall(version: string, errorCode: InstallFailureCode, message: string): void {
    log.error('Update did not install', {
      event: 'update.install',
      errorCode,
      fromVersion: this.updateState.currentVersion,
      toVersion: version,
      message,
    });
    this.installFailure = { version, message };
    this.presentInstallFailure(this.installFailure);
  }

  private presentInstallFailure({ version, message }: { version: string; message: string }): void {
    this.updateState.status = 'install-failed';
    this.updateState.availableVersion = version;
    this.updateState.error = message;
    events.emit(updateInstallFailedEvent, { version, message });
  }

  /**
   * Why this copy of the app cannot install an update in place, checked before a
   * restart is offered. Only macOS replaces the running bundle; elsewhere the
   * installer handles its own permissions.
   */
  private async findInstallBlocker(): Promise<InstallBlocker | null> {
    if (this.fake || process.platform !== 'darwin') return null;
    const bundlePath = macAppBundlePath(process.execPath);
    const uid = process.getuid?.();
    if (!bundlePath || uid === undefined) {
      log.warn('Cannot check whether the update can be installed', {
        event: 'update.install',
        stage: 'preflight',
        errorCode: 'no_app_bundle',
        executable: process.execPath,
      });
      return null;
    }
    try {
      return await findInstallBlocker(bundlePath, uid);
    } catch (error) {
      log.warn('Cannot check whether the update can be installed', {
        event: 'update.install',
        stage: 'preflight',
        errorCode: 'stat_failed',
        bundlePath,
        error: String(error),
      });
      return null;
    }
  }

  private async offerInstall(version: string): Promise<void> {
    const blocker = await this.findInstallBlocker();
    if (blocker) {
      this.failInstall(version, `blocked_${blocker.reason}`, describeBlocker(blocker, version));
      return;
    }
    this.updateState.status = 'downloaded';
    this.updateState.rollbackVersion = this.updateState.currentVersion;
    events.emit(updateDownloadedEvent, { version });
  }

  /**
   * End the install attempt in progress without the app having gone down. One
   * attempt is one event: the app goes down for the installer, or it is still
   * here afterwards, and the latch keeps a handover that later unwinds from
   * being counted in both directions.
   */
  private abandonInstallAttempt(): void {
    if (this.installRestartGuardTimer) {
      clearTimeout(this.installRestartGuardTimer);
      this.installRestartGuardTimer = undefined;
    }
    void pendingInstall.clear();
    trackEvent('update_install_started', { outcome: 'failure' });
    this.installRequested = false;
  }

  private setupAutoUpdater(): void {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = ALLOW_PRERELEASE;
    autoUpdater.allowDowngrade = ALLOW_DOWNGRADE;
    autoUpdater.requestHeaders = { 'Cache-Control': 'no-cache' };

    const updaterLogger: UpdaterLogger = {
      info: (...args: unknown[]) => log.debug('[autoUpdater]', ...sanitizeUpdaterLogArgs(args)),
      warn: (...args: unknown[]) => log.warn('[autoUpdater]', ...sanitizeUpdaterLogArgs(args)),
      error: (...args: unknown[]) => log.error('[autoUpdater]', ...sanitizeUpdaterLogArgs(args)),
    };
    autoUpdater.logger = updaterLogger;
  }

  /**
   * State transitions, shared by the real autoUpdater listeners and the dev
   * harness so both drive the app through identical states.
   */
  private readonly signals: UpdateSignals = {
    checking: () => {
      this.updateState.status = 'checking';
      this.updateState.lastCheck = new Date();
      events.emit(updateCheckingEvent, undefined);
    },

    available: (info: UpdateInfo) => {
      if (this.installFailure && info.version === this.installFailure.version) {
        this.updateState.updateInfo = info;
        this.presentInstallFailure(this.installFailure);
        return;
      }
      this.updateState.status = 'available';
      this.updateState.availableVersion = info.version;
      this.updateState.updateInfo = info;
      events.emit(updateAvailableEvent, { version: info.version, updateInfo: info });
    },

    notAvailable: () => {
      this.installFailure = undefined;
      this.updateState.status = 'idle';
      events.emit(updateNotAvailableEvent, undefined);
    },

    failed: (err: unknown) => {
      const errorMessage = formatUpdaterError(err);
      log.error('Auto-updater error', {
        event: 'update.error',
        errorCode: updaterErrorCode(err),
        message: errorMessage,
      });

      // Squirrel.Mac reports a bundle it cannot replace here, after the
      // handover and before the app would have quit.
      if (this.installRequested && this.installingVersion) {
        this.abandonInstallAttempt();
        this.failInstall(
          this.installingVersion,
          'installer_error',
          `Version ${this.installingVersion} didn't install: ${errorMessage}`
        );
        return;
      }

      const previousVersion = this.updateState.availableVersion;
      const previousInfo = this.updateState.updateInfo;

      this.updateState.status = 'error';
      this.updateState.error = errorMessage;

      if (previousVersion) {
        this.updateState.availableVersion = previousVersion;
        this.updateState.updateInfo = previousInfo;
      }

      events.emit(updateErrorEvent, { message: errorMessage });
    },

    progress: (progress) => {
      this.updateState.status = 'downloading';
      this.updateState.downloadProgress = progress;
      events.emit(updateProgressEvent, progress);
    },

    downloaded: (version: string) => {
      void this.offerInstall(version);
    },
  };

  private setupEventListeners(): void {
    autoUpdater.on('checking-for-update', () => this.signals.checking());

    autoUpdater.on('update-available', (info: UpdateInfo) => this.signals.available(info));

    autoUpdater.on('update-not-available', () => this.signals.notAvailable());

    autoUpdater.on('error', (err: Error) => this.signals.failed(err));

    autoUpdater.on('download-progress', (progressObj: ProgressInfo) =>
      this.signals.progress({
        bytesPerSecond: progressObj.bytesPerSecond,
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total,
      })
    );

    autoUpdater.on('update-downloaded', (info: UpdateInfo) =>
      this.signals.downloaded(info.version)
    );
  }

  private scheduleNextCheck(delay = CHECK_INTERVAL_MS): void {
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
    }
    this.updateState.nextCheck = new Date(Date.now() + delay);
    this.checkTimer = setTimeout(() => {
      this.checkForUpdates('scheduled').catch((e) => {
        log.error('Scheduled update check failed:', e);
      });
    }, delay);
  }

  /**
   * Check for an update.
   *
   * `trigger` says who asked. A check that arrives while one is already running
   * joins it rather than starting a second, so it is reported under the trigger
   * of the check that actually ran — the alternative is counting one check twice.
   */
  async checkForUpdates(trigger: TelemetryUpdateTrigger = 'user'): Promise<UpdateInfo | null> {
    if (!this.active) return null;
    if (this.currentCheckPromise) return this.currentCheckPromise;

    this.currentCheckPromise = this._performCheck()
      .then((info) => {
        trackEvent('update_checked', {
          trigger: updateTriggerOf(trigger),
          result: info ? 'available' : 'up_to_date',
        });
        return info;
      })
      .catch((error: unknown) => {
        trackEvent('update_checked', { trigger: updateTriggerOf(trigger), result: 'failed' });
        throw error;
      })
      .finally(() => {
        this.currentCheckPromise = null;
        this.scheduleNextCheck();
      });

    return this.currentCheckPromise;
  }

  private async _performCheck(): Promise<UpdateInfo | null> {
    if (this.updateState.status === 'error') {
      this.updateState.status = 'idle';
      this.updateState.error = undefined;
    }

    if (this.fake) return this.fake.check();

    if (IS_CANARY) {
      let url: string;
      try {
        url = await resolveCanaryFeedUrl();
      } catch (error) {
        // The updater never runs, so its error listener cannot report this.
        this.signals.failed(error);
        throw error;
      }
      autoUpdater.setFeedURL({ provider: 'generic', url, channel: 'canary' });
    } else {
      autoUpdater.setFeedURL({
        provider: 'github',
        owner: RELEASE_REPO_OWNER,
        repo: RELEASE_REPO_NAME,
      });
    }

    log.info('Checking for updates...', {
      channel: UPDATE_CHANNEL,
      currentVersion: this.updateState.currentVersion,
    });

    const result = await autoUpdater.checkForUpdatesAndNotify();
    // Both branches of the updater's check carry an `updateInfo`: the
    // not-available one returns the release it just compared this build against.
    // `isUpdateAvailable` is the field that separates them, and null here is what
    // every caller reads as "nothing to install".
    return result?.isUpdateAvailable ? result.updateInfo : null;
  }

  async downloadUpdate(): Promise<void> {
    if (!this.active) throw new Error('Update service is not active');
    if (this.updateState.status === 'error' && this.updateState.availableVersion) {
      this.updateState.status = 'available';
    }

    if (this.updateState.status !== 'available') {
      throw new Error(`Cannot download: status is "${this.updateState.status}", not "available"`);
    }

    if (!this.updateState.availableVersion) {
      throw new Error('No version information available for download');
    }

    this.updateState.status = 'downloading';
    events.emit(updateDownloadingEvent, { version: this.updateState.availableVersion });

    try {
      if (this.fake) await this.fake.download();
      else await autoUpdater.downloadUpdate();
      trackEvent('update_downloaded', { outcome: 'success' });
    } catch (error: unknown) {
      trackEvent('update_downloaded', { outcome: 'failure' });
      const errorMessage = formatUpdaterError(error);
      log.error('Update download failed', {
        event: 'update.download',
        errorCode: updaterErrorCode(error),
        message: errorMessage,
      });

      const version = this.updateState.availableVersion;
      const info = this.updateState.updateInfo;

      this.updateState.status = 'error';
      this.updateState.error = errorMessage;
      this.updateState.availableVersion = version;
      this.updateState.updateInfo = info;

      events.emit(updateErrorEvent, { message: errorMessage });
      throw error;
    }
  }

  quitAndInstall(): void {
    if (!this.active) throw new Error('Update service is not active');
    if (this.installRequested) {
      log.info('quitAndInstall ignored: install already requested');
      return;
    }

    if (this.updateState.status !== 'downloaded') {
      throw new Error(
        `Cannot install update: status is "${this.updateState.status}", expected "downloaded"`
      );
    }

    const version = this.updateState.availableVersion;
    if (!version) throw new Error('Cannot install update: no version was downloaded');

    this.installRequested = true;
    this.installingVersion = version;
    this.updateState.status = 'installing';
    events.emit(updateInstallingEvent, undefined);

    log.info('Installing update', {
      fromVersion: this.updateState.currentVersion,
      toVersion: version,
    });

    if (this.fake) {
      // A dev build has no new binary to restart into. Unwind quickly so the
      // "ready to install" state is reachable again instead of stranding the UI
      // on "installing" until the two-minute guard fires.
      this.installRestartGuardTimer = setTimeout(() => {
        this.abandonInstallAttempt();
        if (this.fake?.scenario === 'install-error') {
          this.failInstall(
            version,
            'installer_error',
            `Version ${version} didn't install: simulated installer failure`
          );
          return;
        }
        this.updateState.status = 'downloaded';
        events.emit(updateDownloadedEvent, { version });
        log.info('[dev] Simulated install complete — no restart happens under the update harness');
      }, FAKE_INSTALL_ROLLBACK_MS);
      return;
    }

    // Written before handing over, and read on the next launch. A successful
    // install takes the process down with it, so there is no moment inside this
    // one at which success can be sent: `before-quit` runs after the shutdown
    // handler that calls `app.exit`, and even first in the queue it would be
    // racing a consent read and an HTTP post against the process ending. A
    // record that survives the restart is the only version of this that is not
    // a guess, and the marker's absence is what an abandoned attempt uses to say
    // the handover did not take.
    void pendingInstall.set(version);

    this.installRestartGuardTimer = setTimeout(() => {
      this.abandonInstallAttempt();
      this.failInstall(
        version,
        'restart_timeout',
        `Version ${version} didn't install: ${PRODUCT_NAME} was still running two minutes after the restart.`
      );
    }, INSTALL_RESTART_GUARD_TIMEOUT_MS);

    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        this.abandonInstallAttempt();
        this.failInstall(
          version,
          'handover_threw',
          `Version ${version} didn't install: ${formatUpdaterError(error)}`
        );
      }
    }, 250);
  }

  async fetchReleaseNotes(): Promise<string | null> {
    try {
      if (!this.updateState.updateInfo) {
        return null;
      }

      const releaseNotes = this.updateState.updateInfo.releaseNotes;
      if (releaseNotes) {
        const normalizedReleaseNotes =
          typeof releaseNotes === 'string'
            ? releaseNotes
            : releaseNotes
                .map((note) => note.note)
                .filter((note): note is string => typeof note === 'string' && note.length > 0)
                .join('\n\n');
        if (normalizedReleaseNotes) {
          this.updateState.releaseNotes = normalizedReleaseNotes;
          return normalizedReleaseNotes;
        }
      }

      const version = this.updateState.availableVersion;
      if (!version) return null;

      const response = await fetch(switchConsoleReleaseApiUrl(version));

      if (!response.ok) {
        log.warn('Could not fetch release notes', {
          event: 'update.release_notes',
          stage: 'fetch',
          errorCode: `http_${response.status}`,
          version,
        });
        return null;
      }

      const data = (await response.json()) as { body?: string };
      const notes = data.body || 'No release notes available';
      this.updateState.releaseNotes = notes;
      return notes;
    } catch (error) {
      log.error('Failed to fetch release notes:', error);
      return null;
    }
  }

  getState(): UpdateState {
    return { ...this.updateState };
  }

  dispose(): void {
    this.fake?.dispose();
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = undefined;
    }
    if (this.installRestartGuardTimer) {
      clearTimeout(this.installRestartGuardTimer);
      this.installRestartGuardTimer = undefined;
    }
  }
}

export const updateService = new UpdateService();
