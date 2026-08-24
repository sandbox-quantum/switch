import { action, computed, makeObservable, observable, runInAction } from 'mobx';
import { toast } from 'sonner';
import { createUpdateToastActionLabel } from '@renderer/lib/components/update-toast-action-label';
import { events, rpc } from '@renderer/lib/ipc';
import { openExternalUrl } from '@renderer/lib/open-external';
import { appState } from '@renderer/lib/stores/app-state';
import { menuCheckForUpdatesChannel } from '@shared/events/appEvents';
import {
  updateAvailableEvent,
  updateCheckingEvent,
  updateDownloadedEvent,
  updateDownloadingEvent,
  updateErrorEvent,
  updateInstallingEvent,
  updateNotAvailableEvent,
  updateProgressEvent,
} from '@shared/events/updateEvents';
import { switchConsoleReleaseUrl } from '@shared/urls';

const LAST_NOTIFIED_KEY = 'switchdash:update:lastNotified';
const SNOOZE_HOURS = 6;

type DownloadProgress = {
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
};

export type UpdateReleaseInfo = {
  version: string;
  releaseDate?: string;
  releaseName?: string | null;
};

export type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'available'; info?: UpdateReleaseInfo }
  | { status: 'not-available' }
  | { status: 'downloading'; progress?: DownloadProgress }
  | { status: 'downloaded' }
  | { status: 'installing' }
  | { status: 'error'; message: string };

/** Statuses where main is mid-flight and a fresh check would interrupt it. */
const IN_FLIGHT_STATUSES: ReadonlySet<UpdateState['status']> = new Set([
  'downloading',
  'downloaded',
  'installing',
]);

/**
 * Shape of the main-process update state, described structurally so the
 * renderer does not import from @main. Keep in sync with UpdateState in
 * src/main/core/updates/update-service.ts.
 */
type MainUpdateState = {
  status: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error';
  currentVersion: string;
  availableVersion?: string;
  updateInfo?: { version: string; releaseDate?: string; releaseName?: string | null };
  downloadProgress?: DownloadProgress;
  error?: string;
};

export function mainStateToRendererState(main: MainUpdateState): UpdateState {
  switch (main.status) {
    case 'checking':
      return { status: 'checking' };
    case 'available':
      return {
        status: 'available',
        info: main.availableVersion
          ? {
              version: main.availableVersion,
              releaseDate: main.updateInfo?.releaseDate,
              releaseName: main.updateInfo?.releaseName,
            }
          : undefined,
      };
    case 'downloading':
      return { status: 'downloading', progress: main.downloadProgress };
    case 'downloaded':
      return { status: 'downloaded' };
    case 'installing':
      return { status: 'installing' };
    case 'error':
      return { status: 'error', message: main.error || 'The update could not be completed.' };
    default:
      return { status: 'idle' };
  }
}

export class UpdateStore {
  state: UpdateState = { status: 'idle' };
  currentVersion = '';
  availableVersion: string | undefined = undefined;

  constructor() {
    makeObservable(this, {
      state: observable,
      currentVersion: observable,
      availableVersion: observable,
      setState: action,
      hasUpdate: computed,
      progressLabel: computed,
      latestVersion: computed,
      releaseUrl: computed,
    });
  }

  get hasUpdate(): boolean {
    const { status } = this.state;
    return status === 'available' || status === 'downloading' || status === 'downloaded';
  }

  setState(state: UpdateState): void {
    this.state = state;
  }

  get progressLabel(): string {
    if (this.state.status !== 'downloading') return '';
    const p = this.state.progress?.percent ?? 0;
    return `${p.toFixed(0)}%`;
  }

  /** Version being offered/downloaded, independent of the current status. */
  get latestVersion(): string | undefined {
    if (this.state.status === 'available' && this.state.info?.version) {
      return this.state.info.version;
    }
    return this.availableVersion;
  }

  get releaseUrl(): string {
    return switchConsoleReleaseUrl(this.latestVersion);
  }

  start(): void {
    void rpc.app.getAppVersion().then((v) => {
      runInAction(() => {
        this.currentVersion = v;
      });
    });

    events.on(updateCheckingEvent, () => {
      runInAction(() => {
        this.state = { status: 'checking' };
      });
    });

    events.on(updateAvailableEvent, (d) => {
      runInAction(() => {
        this.availableVersion = d.version;
        this.state = {
          status: 'available',
          info: {
            version: d.version,
            releaseDate: d.updateInfo?.releaseDate,
            releaseName: d.updateInfo?.releaseName,
          },
        };
      });
      this._maybeToastAvailable(d.version);
    });

    events.on(updateNotAvailableEvent, () => {
      runInAction(() => {
        this.state = { status: 'not-available' };
      });
    });

    events.on(updateDownloadingEvent, (_d) => {
      runInAction(() => {
        this.state = { status: 'downloading', progress: { percent: 0 } };
      });
    });

    events.on(updateProgressEvent, (d) => {
      runInAction(() => {
        this.state = {
          status: 'downloading',
          progress: {
            percent: d.percent,
            transferred: d.transferred,
            total: d.total,
            bytesPerSecond: d.bytesPerSecond,
          },
        };
      });
    });

    events.on(updateDownloadedEvent, (d) => {
      runInAction(() => {
        if (d?.version) this.availableVersion = d.version;
        this.state = { status: 'downloaded' };
      });
    });

    events.on(updateInstallingEvent, () => {
      runInAction(() => {
        this.state = { status: 'installing' };
      });
    });

    events.on(updateErrorEvent, (d) => {
      runInAction(() => {
        this.state = { status: 'error', message: d.message };
      });
    });

    events.on(menuCheckForUpdatesChannel, () => {
      void this.check();
    });

    // Adopt whatever main already knows before kicking off a new check: a
    // renderer reload during a download would otherwise show idle while the
    // download continues in the background.
    void this._resyncFromMain().then(() => {
      if (IN_FLIGHT_STATUSES.has(this.state.status)) return;
      rpc.update.check('startup').catch(() => {});
    });
  }

  private async _resyncFromMain(): Promise<void> {
    try {
      const res = await rpc.update.getState();
      if (!res?.success || !res.data) return;
      const main = res.data;

      runInAction(() => {
        if (main.currentVersion && main.currentVersion !== 'unknown') {
          this.currentVersion = main.currentVersion;
        }
        this.availableVersion = main.availableVersion;
        this.state = mainStateToRendererState(main);
      });
    } catch {
      // A failed resync is not itself an update failure — the check that
      // follows will establish real state.
    }
  }

  async check(): Promise<void> {
    runInAction(() => {
      this.state = { status: 'checking' };
    });
    try {
      const res = await rpc.update.check();
      if (!res) {
        runInAction(() => {
          this.state = { status: 'error', message: 'Update API unavailable' };
        });
        return;
      }
      if (!res.success) {
        runInAction(() => {
          this.state = { status: 'error', message: res.error ?? 'Failed to check for updates' };
        });
      } else if (res.result === null) {
        runInAction(() => {
          this.state = { status: 'idle' };
        });
      }
    } catch {
      runInAction(() => {
        this.state = { status: 'error', message: 'Failed to check for updates' };
      });
    }
  }

  async download(): Promise<void> {
    try {
      const res = await rpc.update.download();
      if (!res) {
        this._failUserAction('Update API unavailable');
        return;
      }
      if (!res.success) {
        this._failUserAction(res.error ?? 'Failed to download update');
      }
    } catch {
      this._failUserAction('Failed to download update');
    }
  }

  async install(): Promise<void> {
    runInAction(() => {
      this.state = { status: 'installing' };
    });
    try {
      const res = await rpc.update.quitAndInstall();
      if (!res) {
        this._failUserAction('Update API unavailable');
        return;
      }
      if (!res.success) {
        this._failUserAction(res.error ?? 'Failed to install update');
      }
    } catch {
      this._failUserAction('Failed to install update');
    }
  }

  async openLatest(): Promise<void> {
    try {
      await rpc.update.openLatest();
    } catch {
      // openLatest quits the app — errors are best-effort
    }
  }

  /** Open this update's GitHub release page in the user's browser. */
  async openReleasePage(): Promise<void> {
    await openExternalUrl(this.releaseUrl, 'Could not open the release page');
  }

  /**
   * Record a failure the user personally triggered. Background check failures
   * only tint the sidebar indicator; a click that fails gets a toast, because
   * the user is waiting on an answer.
   */
  private _failUserAction(message: string): void {
    runInAction(() => {
      this.state = { status: 'error', message };
    });
    toast.error('Update failed', { description: message, duration: 8_000 });
  }

  private _maybeToastAvailable(version: string): void {
    if (!this._shouldNotify(version)) return;
    this._showAvailableToast(version);
    this._rememberNotified(version);
  }

  private _showAvailableToast(version: string): void {
    toast('Update Available', {
      description: `Version ${version} is available to download and install.`,
      duration: 10_000,
      classNames: {
        actionButton:
          'group/action cursor-pointer transition-all duration-150 hover:bg-primary/85 active:scale-[0.97]',
      },
      action: {
        label: createUpdateToastActionLabel(),
        onClick: () => {
          appState.navigation.navigate('settings', { tab: 'general' });
          if (this.state.status === 'available') {
            void this.download();
          }
        },
      },
    });
  }

  private _shouldNotify(version: string): boolean {
    try {
      const raw = localStorage.getItem(LAST_NOTIFIED_KEY);
      if (!raw) return true;
      const parsed = JSON.parse(raw) as { version?: string; at?: number };
      if (parsed.version === version) {
        const at = parsed.at ?? 0;
        if (Date.now() - at < Math.max(1, SNOOZE_HOURS) * 3_600_000) return false;
      }
      return true;
    } catch {
      return true;
    }
  }

  private _rememberNotified(version: string): void {
    try {
      localStorage.setItem(LAST_NOTIFIED_KEY, JSON.stringify({ version, at: Date.now() }));
    } catch {
      // localStorage may be unavailable
    }
  }
}
