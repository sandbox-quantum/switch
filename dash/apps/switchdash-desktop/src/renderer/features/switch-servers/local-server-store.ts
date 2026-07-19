import { makeAutoObservable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import type {
  DockerAvailability,
  LocalServerStatus,
} from '@shared/core/local-switch-server/local-switch-server';
import {
  localServerLogChannel,
  localServerStatusChannel,
} from '@shared/events/localSwitchServerEvents';
import { switchServersStore } from './switch-servers-store';

/** Cap the retained log tail so a long pull can't grow the buffer unbounded. */
const MAX_LOG_LINES = 400;

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
  error: string | null = null;
  /** Live `docker compose` output tail during a start. */
  logs: string[] = [];

  private off: (() => void) | null = null;
  private offLog: (() => void) | null = null;

  constructor() {
    makeAutoObservable(this);
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
      this.offLog = events.on(localServerLogChannel, ({ line }) => {
        runInAction(() => {
          this.logs.push(line);
          if (this.logs.length > MAX_LOG_LINES) {
            this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
          }
        });
      });
    }
    try {
      const status = await rpc.localSwitchServer.getStatus();
      runInAction(() => {
        this.status = status;
      });
    } catch (cause) {
      this.setError(cause);
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.offLog?.();
    this.offLog = null;
  }

  async checkDocker(): Promise<void> {
    try {
      const docker = await rpc.localSwitchServer.detectDocker();
      runInAction(() => {
        this.docker = docker;
      });
    } catch (cause) {
      this.setError(cause);
    }
  }

  async start(): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.error = null;
      this.logs = [];
    });
    try {
      const result = await rpc.localSwitchServer.start();
      if (result.kind === 'docker-unavailable') {
        runInAction(() => {
          this.docker = { available: false, reason: result.reason, detail: result.detail };
          this.error = result.detail;
        });
      } else if (result.kind === 'error') {
        runInAction(() => {
          this.error = result.message;
        });
      } else {
        await switchServersStore.init();
      }
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async stop(): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.error = null;
    });
    try {
      await rpc.localSwitchServer.stop();
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  async reset(): Promise<void> {
    runInAction(() => {
      this.busy = true;
      this.error = null;
    });
    try {
      await rpc.localSwitchServer.reset();
      await switchServersStore.init();
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => {
        this.busy = false;
      });
    }
  }

  private setError(cause: unknown): void {
    runInAction(() => {
      this.error = cause instanceof Error ? cause.message : String(cause);
    });
  }
}

export const localServerStore = new LocalServerStore();
