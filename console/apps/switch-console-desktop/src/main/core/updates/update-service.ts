import type { IDisposable, IInitializable } from '@switch-console/shared';
import _electronUpdater, {
  type ProgressInfo,
  type UpdateInfo,
  type Logger as UpdaterLogger,
} from 'electron-updater';
import { resolveAppVersion } from '@main/core/app/utils';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  IS_CANARY,
  RELEASE_REPO_NAME,
  RELEASE_REPO_OWNER,
  UPDATE_CHANNEL,
} from '@shared/app-identity';
import {
  updateAuthRequiredEvent,
  updateAvailableEvent,
  updateCheckingEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateErrorEvent,
  updateInstallingEvent,
  updateNotAvailableEvent,
  updateProgressEvent,
} from '@shared/events/updateEvents';
import { switchConsoleReleaseApiUrl } from '@shared/urls';
import {
  FAKE_UPDATE_VERSION_ENV_VAR,
  FakeUpdateDriver,
  type UpdateSignals,
  nextFakeVersion,
  readFakeDownloadDuration,
  readFakeUpdateScenario,
} from './dev-harness';
import { getGithubTokenFromGhCli } from './github-token';
import { formatUpdaterError, sanitizeUpdaterLogArgs } from './utils';

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

export interface UpdateState {
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error'
    | 'auth-required';
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
      this.updateState.status = 'available';
      this.updateState.availableVersion = info.version;
      this.updateState.updateInfo = info;
      events.emit(updateAvailableEvent, { version: info.version, updateInfo: info });
    },

    notAvailable: () => {
      this.updateState.status = 'idle';
      events.emit(updateNotAvailableEvent, undefined);
    },

    failed: (err: unknown) => {
      const errorMessage = formatUpdaterError(err);
      log.error('Auto-updater error:', errorMessage);

      if (this.updateState.status === 'installing') {
        log.warn('Ignoring auto-updater error while install is in progress');
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
      this.updateState.status = 'downloaded';
      this.updateState.rollbackVersion = this.updateState.currentVersion;
      events.emit(updateDownloadedEvent, { version });
    },

    authRequired: () => {
      this.updateState.status = 'auth-required';
      events.emit(updateAuthRequiredEvent, undefined);
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
      this.checkForUpdates().catch((e) => {
        log.error('Scheduled update check failed:', e);
      });
    }, delay);
  }

  async checkForUpdates(): Promise<UpdateInfo | null> {
    if (!this.active) return null;
    if (this.currentCheckPromise) return this.currentCheckPromise;

    this.currentCheckPromise = this._performCheck().finally(() => {
      this.currentCheckPromise = null;
      this.scheduleNextCheck();
    });

    return this.currentCheckPromise;
  }

  private async _performCheck(): Promise<UpdateInfo | null> {
    if (this.updateState.status === 'error' || this.updateState.status === 'auth-required') {
      this.updateState.status = 'idle';
      this.updateState.error = undefined;
    }

    if (this.fake) return this.fake.check();

    // The switch release feed is a private repo, so the updater needs a token.
    // Reuse the user's existing `gh` login rather than shipping a secret. Without
    // a token we stay dormant (auth-required) instead of erroring every hour.
    const token = await getGithubTokenFromGhCli();
    if (!token) {
      this.signals.authRequired();
      log.info('Skipping update check: no GitHub token from gh CLI (run `gh auth login`)');
      return null;
    }
    // A private repo needs electron-updater's authenticated provider
    // (api.github.com); the public releases.atom feed 404s and the auth header
    // alone does not select it. The token goes through setFeedURL rather than
    // GH_TOKEN: the environment is inherited by every child process Switch Console
    // spawns — including `gh` itself, which prefers GH_TOKEN over the keyring —
    // so a token left there outlives the login it came from and shadows the
    // next one until the app restarts.
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: RELEASE_REPO_OWNER,
      repo: RELEASE_REPO_NAME,
      private: true,
      token,
    });
    autoUpdater.requestHeaders = {
      'Cache-Control': 'no-cache',
      authorization: `token ${token}`,
    };

    log.info('Checking for updates...', {
      channel: UPDATE_CHANNEL,
      currentVersion: this.updateState.currentVersion,
    });

    const result = await autoUpdater.checkForUpdatesAndNotify();
    return result?.updateInfo ?? null;
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
    } catch (error: unknown) {
      const errorMessage = formatUpdaterError(error);
      log.error('Update download failed:', errorMessage, error);

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

    this.installRequested = true;
    this.updateState.status = 'installing';
    events.emit(updateInstallingEvent, undefined);

    log.info('Installing update', {
      fromVersion: this.updateState.currentVersion,
      toVersion: this.updateState.availableVersion,
    });

    const clearGuard = () => {
      if (this.installRestartGuardTimer) {
        clearTimeout(this.installRestartGuardTimer);
        this.installRestartGuardTimer = undefined;
      }
    };

    const rollback = (reason: string) => {
      clearGuard();
      this.installRequested = false;
      this.updateState.status = 'downloaded';
      if (this.updateState.availableVersion) {
        events.emit(updateDownloadedEvent, { version: this.updateState.availableVersion });
      }
      log.error(reason);
    };

    if (this.fake) {
      // A dev build has no new binary to restart into. Unwind quickly so the
      // "ready to install" state is reachable again instead of stranding the UI
      // on "installing" until the two-minute guard fires.
      this.installRestartGuardTimer = setTimeout(() => {
        rollback('[dev] Simulated install complete — no restart happens under the update harness');
      }, FAKE_INSTALL_ROLLBACK_MS);
      return;
    }

    this.installRestartGuardTimer = setTimeout(() => {
      rollback('quitAndInstall timed out before app quit; allowing retry');
    }, INSTALL_RESTART_GUARD_TIMEOUT_MS);

    setTimeout(() => {
      try {
        autoUpdater.quitAndInstall(false, true);
      } catch (error) {
        rollback(`quitAndInstall threw: ${formatUpdaterError(error)}`);
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

      // The release feed is a private repo: an unauthenticated read 404s on
      // every release, so reuse the token the update check already relies on.
      const token = await getGithubTokenFromGhCli();
      const response = await fetch(switchConsoleReleaseApiUrl(version), {
        headers: token ? { authorization: `token ${token}` } : {},
      });

      if (!response.ok) {
        log.warn('Could not fetch release notes', {
          event: 'update.release_notes',
          stage: 'fetch',
          errorCode: `http_${response.status}`,
          version,
          authenticated: token !== null,
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
