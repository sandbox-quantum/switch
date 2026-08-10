import type { UpdateInfo } from 'electron-updater';

/**
 * Dev-only driver that replays the update lifecycle without a real release
 * feed. The updater is inert outside packaged builds, so this is the only way
 * to exercise the update UI locally.
 *
 * Enable with SWITCHDASH_FAKE_UPDATE=<scenario> in `pnpm dev`. It is refused in
 * packaged builds — see updateService.initialize.
 */

export const FAKE_UPDATE_ENV_VAR = 'SWITCHDASH_FAKE_UPDATE';
export const FAKE_UPDATE_VERSION_ENV_VAR = 'SWITCHDASH_FAKE_UPDATE_VERSION';
export const FAKE_UPDATE_DURATION_ENV_VAR = 'SWITCHDASH_FAKE_UPDATE_MS';

export const FAKE_UPDATE_SCENARIOS = [
  /** Check finds an update; download succeeds; install rolls back (dev cannot restart). */
  'available',
  /** Check finds an update; the download fails part-way. */
  'download-error',
  /** The check itself fails. */
  'check-error',
  /** The check reports no GitHub credentials. */
  'auth-required',
  /** Check finds nothing. */
  'up-to-date',
] as const;

export type FakeUpdateScenario = (typeof FAKE_UPDATE_SCENARIOS)[number];

const DEFAULT_DOWNLOAD_MS = 6_000;
const FAKE_TOTAL_BYTES = 68 * 1024 * 1024;
const PROGRESS_STEPS = 24;

/**
 * Signals the driver raises. The real autoUpdater listeners feed the same
 * methods, so fake and real runs move the service through identical states.
 */
export interface UpdateSignals {
  checking(): void;
  available(info: UpdateInfo): void;
  notAvailable(): void;
  progress(progress: {
    bytesPerSecond: number;
    percent: number;
    transferred: number;
    total: number;
  }): void;
  downloaded(version: string): void;
  failed(error: unknown): void;
  authRequired(): void;
}

export function isFakeUpdateScenario(value: string): value is FakeUpdateScenario {
  return (FAKE_UPDATE_SCENARIOS as readonly string[]).includes(value);
}

/**
 * Read the requested scenario, or null when the harness is off. Throws on an
 * unrecognised value rather than silently running the default — a typo'd
 * scenario should not look like a working update.
 */
export function readFakeUpdateScenario(env: NodeJS.ProcessEnv): FakeUpdateScenario | null {
  const raw = env[FAKE_UPDATE_ENV_VAR]?.trim();
  if (!raw) return null;

  if (!isFakeUpdateScenario(raw)) {
    throw new Error(
      `${FAKE_UPDATE_ENV_VAR}="${raw}" is not a known scenario. Use one of: ${FAKE_UPDATE_SCENARIOS.join(', ')}`
    );
  }

  return raw;
}

/** Next plausible version for the fake feed: bump the minor, reset the patch. */
export function nextFakeVersion(currentVersion: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(currentVersion);
  if (!match) return '99.0.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

export function readFakeDownloadDuration(env: NodeJS.ProcessEnv): number {
  const raw = env[FAKE_UPDATE_DURATION_ENV_VAR];
  if (!raw) return DEFAULT_DOWNLOAD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${FAKE_UPDATE_DURATION_ENV_VAR}="${raw}" is not a positive number of ms`);
  }
  return parsed;
}

export class FakeUpdateDriver {
  private readonly pendingWaits = new Set<{ timer: NodeJS.Timeout; resolve: () => void }>();
  private disposed = false;

  constructor(
    readonly scenario: FakeUpdateScenario,
    private readonly signals: UpdateSignals,
    readonly nextVersion: string,
    private readonly downloadMs: number
  ) {}

  async check(): Promise<UpdateInfo | null> {
    this.signals.checking();
    await this.delay(500);
    if (this.disposed) return null;

    switch (this.scenario) {
      case 'auth-required':
        this.signals.authRequired();
        return null;

      case 'check-error':
        this.signals.failed(new Error('Simulated update check failure (HTTP 503)'));
        return null;

      case 'up-to-date':
        this.signals.notAvailable();
        return null;

      default: {
        const info = this.buildUpdateInfo();
        this.signals.available(info);
        return info;
      }
    }
  }

  /**
   * Mirrors autoUpdater.downloadUpdate: emits progress and either resolves or
   * throws. The service's own error handling converts the throw into the error
   * state, so the failure path is the real one.
   */
  async download(): Promise<void> {
    const stepMs = Math.max(40, this.downloadMs / PROGRESS_STEPS);
    const bytesPerSecond = FAKE_TOTAL_BYTES / (this.downloadMs / 1000);
    const failAtStep = Math.ceil(PROGRESS_STEPS / 3);

    for (let step = 1; step <= PROGRESS_STEPS; step++) {
      await this.delay(stepMs);
      if (this.disposed) return;

      if (this.scenario === 'download-error' && step === failAtStep) {
        throw new Error('Simulated download failure: connection reset by peer');
      }

      const fraction = step / PROGRESS_STEPS;
      this.signals.progress({
        percent: fraction * 100,
        transferred: Math.round(FAKE_TOTAL_BYTES * fraction),
        total: FAKE_TOTAL_BYTES,
        bytesPerSecond,
      });
    }

    this.signals.downloaded(this.nextVersion);
  }

  /**
   * Resolve outstanding waits rather than just cancelling their timers, so an
   * in-flight download settles instead of hanging forever on shutdown. The
   * disposed flag stops the loop before it emits anything further.
   */
  dispose(): void {
    this.disposed = true;
    for (const wait of this.pendingWaits) {
      clearTimeout(wait.timer);
      wait.resolve();
    }
    this.pendingWaits.clear();
  }

  private buildUpdateInfo(): UpdateInfo {
    return {
      version: this.nextVersion,
      files: [],
      path: '',
      sha512: '',
      releaseDate: new Date().toISOString(),
      releaseName: `Switch Console ${this.nextVersion}`,
    } as UpdateInfo;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wait = {
        resolve,
        timer: setTimeout(() => {
          this.pendingWaits.delete(wait);
          resolve();
        }, ms),
      };
      this.pendingWaits.add(wait);
    });
  }
}
