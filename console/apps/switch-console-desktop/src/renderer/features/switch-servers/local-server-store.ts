import { makeAutoObservable, runInAction } from 'mobx';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import type {
  CheckoutBuild,
  DockerAvailability,
  LocalServerStatus,
  SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  localServerLogChannel,
  localServerStatusChannel,
} from '@shared/events/localSwitchServerEvents';
import { switchServersStore } from './switch-servers-store';

/** Cap the retained log tail so a long pull can't grow the buffer unbounded. */
const MAX_LOG_LINES = 400;

/**
 * How often the tail is allowed to repaint.
 *
 * `docker compose` reports a pull faster than a person can read and far faster
 * than the UI can usefully redraw — a few images' worth of layers runs to
 * hundreds of lines a second, sustained for minutes on a first run. One store
 * write per line means one render of the whole dialog per line, each rebuilding
 * the tail and measuring it to scroll; the renderer stops painting and the
 * output only lands once the command falls quiet. Lines are collected and
 * applied in batches instead.
 */
const LOG_FLUSH_MS = 100;

/**
 * Renderer store for local-server mode. Mirrors the main-process supervisor's
 * status (streamed over `localServerStatusChannel`) and exposes the lifecycle
 * actions. On a successful start/reset it refreshes the servers store so the
 * managed server record appears/updates in the sidebar.
 */
export class LocalServerStore {
  status: LocalServerStatus | null = null;
  docker: DockerAvailability | null = null;
  /** True while a start/stop/reset RPC is in flight. */
  busy = false;
  /** The sentence the page leads with. Never raw exception text. */
  error: string | null = null;
  /** Diagnostics for the same failure, rendered under `error` rather than in it. */
  errorDetail: string | null = null;
  /** Live `docker compose` output tail during a start. */
  logs: string[] = [];

  private off: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  /** Lines received since the last flush. Not observable: reading it would
   *  defeat the batching it exists for. */
  /* internal */ pendingLines: string[] = [];
  /* internal */ flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable(this, { pendingLines: false, flushTimer: false });
  }

  /** Headline and detail as one string, for the modals that have a single slot. */
  get errorText(): string | null {
    if (!this.error) return null;
    return this.errorDetail ? `${this.error} (${this.errorDetail})` : this.error;
  }

  get phase(): LocalServerStatus['phase'] {
    return this.status?.phase ?? 'stopped';
  }

  get message(): string | null {
    return this.status?.message ?? null;
  }

  get isRunning(): boolean {
    return this.phase === 'running';
  }

  /** Set when the stack's switch-core differs from the version this build pins. */
  get drift(): SwitchVersionDrift | null {
    return this.status?.drift ?? null;
  }

  /** Dev builds launched from a Switch checkout only: the checkout the stack's
   * images can be built from, and whether that is on. Null everywhere else, and
   * the controls hide the option when it is. */
  get checkoutBuild(): CheckoutBuild | null {
    return this.status?.checkoutBuild ?? null;
  }

  get isTransitioning(): boolean {
    return this.busy || this.phase === 'starting' || this.phase === 'stopping';
  }

  async init(): Promise<void> {
    if (!this.off) {
      this.off = events.on(localServerStatusChannel, (status) => {
        runInAction(() => {
          this.status = status;
        });
      });
    }
    if (!this.offLog) {
      this.offLog = events.on(localServerLogChannel, ({ line }) => this.queueLine(line));
    }
    try {
      const status = await rpc.localSwitchServer.getStatus();
      runInAction(() => {
        this.status = status;
      });
    } catch (cause) {
      this.setError(cause, 'Could not read the server status.');
    }
  }

  /** Collects a line for the next flush. Public for the batching test. */
  queueLine(line: string): void {
    this.pendingLines.push(line);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushLines(), LOG_FLUSH_MS);
  }

  /** Applies the batch. Exposed for tests and for the end of a run, where the
   *  last few lines must not wait on a timer that may never fire. */
  flushLines(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingLines.length === 0) return;
    const batch = this.pendingLines;
    this.pendingLines = [];
    runInAction(() => {
      this.logs.push(...batch);
      if (this.logs.length > MAX_LOG_LINES) {
        this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
      }
    });
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.offLog?.();
    this.offLog = null;
    this.flushLines();
  }

  async checkDocker(): Promise<void> {
    try {
      const docker = await rpc.localSwitchServer.detectDocker();
      runInAction(() => {
        this.docker = docker;
      });
    } catch (cause) {
      this.setError(cause, 'Could not check Docker availability.');
    }
  }

  async start(): Promise<void> {
    this.pendingLines = [];
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    runInAction(() => {
      this.busy = true;
      this.error = null;
      this.errorDetail = null;
      this.logs = [];
    });
    try {
      const result = await rpc.localSwitchServer.start();
      if (result.kind === 'docker-unavailable') {
        runInAction(() => {
          this.docker = { available: false, reason: result.reason, detail: result.detail };
          this.error = result.detail;
        });
      } else if (result.kind === 'version-downgrade') {
        // The refusal is already on the pushed status as `drift`, which the
        // drift notice explains in full — a second copy in the generic error
        // alert would just say the same thing twice.
      } else if (result.kind === 'error') {
        runInAction(() => {
          this.error = result.message;
        });
      } else {
        await switchServersStore.init();
      }
    } catch (cause) {
      this.setError(cause, 'Could not start the server.');
    } finally {
      // The command has finished, so nothing more will arrive to trigger a
      // flush — the tail's last lines are the ones that say how it went.
      this.flushLines();
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async stop(): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.error = null;
      this.errorDetail = null;
    });
    try {
      await rpc.localSwitchServer.stop();
    } catch (cause) {
      this.setError(cause, 'Could not stop the server.');
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  /** Dev-only: build the stack from the local checkout from the next start on.
   * The main process pushes the new status, so nothing is mirrored here. */
  async setCheckoutBuild(enabled: boolean): Promise<void> {
    try {
      await rpc.localSwitchServer.setCheckoutBuild(enabled);
    } catch (cause) {
      this.setError(cause, 'Could not change where switch-core is built from.');
    }
  }

  async reset(): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.error = null;
      this.errorDetail = null;
    });
    try {
      // The reset deletes the stack's agents itself — their server-side
      // identity dies with it — so this only has to refresh what the deletion
      // changed underneath the UI.
      await rpc.localSwitchServer.reset();
      await agentsStore.load();
      await switchServersStore.init();
    } catch (cause) {
      this.setError(cause, 'Could not reset the server.');
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  /**
   * `error` is rendered directly in banners, so it goes through the shared
   * boundary rather than carrying whatever was thrown. The fallback is
   * per-action: the store knows which request failed, and the failure itself
   * usually does not.
   */
  private setError(cause: unknown, fallback: string): void {
    const { headline, detail } = describeFailure(cause, fallback);
    runInAction(() => {
      this.error = headline;
      this.errorDetail = detail;
    });
  }
}

export const localServerStore = new LocalServerStore();
