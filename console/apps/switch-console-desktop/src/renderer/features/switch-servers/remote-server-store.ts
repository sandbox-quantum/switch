import { makeAutoObservable, runInAction } from 'mobx';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { describeFailure } from '@renderer/lib/errors/describe-failure';
import { events, rpc } from '@renderer/lib/ipc';
import type {
  DockerAvailability,
  SwitchVersionDrift,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type RemoteServerStatus,
  remoteServerLogChannel,
  remoteServerStatusChannel,
} from '@shared/events/remoteSwitchServerEvents';
import { switchServersStore } from './switch-servers-store';

const MAX_LOG_LINES = 400;

/** See the local store: compose reports a pull faster than the UI can redraw,
 *  so lines are applied in batches rather than one render each. */
const LOG_FLUSH_MS = 100;

function defaultStatus(sshHost: string): RemoteServerStatus {
  return {
    sshHost,
    phase: 'stopped',
    serverId: null,
    version: '',
    deployedVersion: null,
    drift: null,
    // A remote stack always runs the pinned released images — the dev checkout
    // build is a local-only option.
    checkoutBuild: null,
    message: null,
    error: null,
  };
}

/**
 * Renderer store for remote-managed servers — one Switch Console-run stack per SSH
 * host. Mirrors the main-process supervisor's per-host status (streamed over
 * `remoteServerStatusChannel`) and exposes the lifecycle actions keyed by host.
 * Structurally a per-host version of {@link LocalServerStore}.
 */
export class RemoteServerStore {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly logsByHost = new Map<string, string[]>();
  private readonly dockerByHost = new Map<string, DockerAvailability>();
  private readonly busyHosts = new Set<string>();
  /** The sentence the page leads with. Never raw exception text. */
  error: string | null = null;
  /** Diagnostics for the same failure, rendered under `error` rather than in it. */
  errorDetail: string | null = null;

  private off: (() => void) | null = null;
  private offLog: (() => void) | null = null;
  /** Lines received since the last flush, per host. Not observable. */
  /* internal */ pendingByHost = new Map<string, string[]>();
  /* internal */ flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    makeAutoObservable(this, { pendingByHost: false, flushTimer: false });
  }

  /** Headline and detail as one string, for the modals that have a single slot. */
  get errorText(): string | null {
    if (!this.error) return null;
    return this.errorDetail ? `${this.error} (${this.errorDetail})` : this.error;
  }

  private queueLine(sshHost: string, line: string): void {
    const pending = this.pendingByHost.get(sshHost) ?? [];
    pending.push(line);
    this.pendingByHost.set(sshHost, pending);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flushLines(), LOG_FLUSH_MS);
  }

  /** Applies the batched lines for every host. */
  flushLines(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.pendingByHost.size === 0) return;
    const batches = this.pendingByHost;
    this.pendingByHost = new Map();
    runInAction(() => {
      for (const [sshHost, batch] of batches) {
        const lines = this.logsByHost.get(sshHost) ?? [];
        lines.push(...batch);
        if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
        this.logsByHost.set(sshHost, lines);
      }
    });
  }

  statusFor(sshHost: string): RemoteServerStatus {
    return this.statuses.get(sshHost) ?? defaultStatus(sshHost);
  }

  phaseFor(sshHost: string): RemoteServerStatus['phase'] {
    return this.statusFor(sshHost).phase;
  }

  /**
   * Whether the host this stack lives on is known-unreachable. Mirrors the
   * main-process gate in `isManagedServerRunning` so the UI and the backend
   * agree on one host-level state (CHOO-1780).
   */
  isHostBlocked(sshHost: string): boolean {
    return hostReachabilityStore.isBlocked(sshHost);
  }

  isRunning(sshHost: string): boolean {
    if (this.isHostBlocked(sshHost)) return false;
    return this.phaseFor(sshHost) === 'running';
  }

  isTransitioning(sshHost: string): boolean {
    const phase = this.phaseFor(sshHost);
    return this.busyHosts.has(sshHost) || phase === 'starting' || phase === 'stopping';
  }

  /** Set when the host's switch-core differs from the version this build pins. */
  driftFor(sshHost: string): SwitchVersionDrift | null {
    return this.statusFor(sshHost).drift;
  }

  logsFor(sshHost: string): string[] {
    return this.logsByHost.get(sshHost) ?? [];
  }

  dockerFor(sshHost: string): DockerAvailability | null {
    return this.dockerByHost.get(sshHost) ?? null;
  }

  async init(): Promise<void> {
    void hostReachabilityStore.hydrate();
    if (!this.off) {
      this.off = events.on(remoteServerStatusChannel, (status) => {
        runInAction(() => this.statuses.set(status.sshHost, status));
      });
    }
    if (!this.offLog) {
      this.offLog = events.on(remoteServerLogChannel, ({ sshHost, line }) =>
        this.queueLine(sshHost, line)
      );
    }
    try {
      const statuses = await rpc.remoteSwitchServer.getStatuses();
      runInAction(() => {
        for (const status of statuses) this.statuses.set(status.sshHost, status);
      });
    } catch (cause) {
      this.setError(cause, 'Could not read the server statuses.');
    }
  }

  dispose(): void {
    this.off?.();
    this.off = null;
    this.offLog?.();
    this.offLog = null;
    this.flushLines();
  }

  async checkDocker(sshHost: string): Promise<void> {
    // Probing Docker over a dead SSH forward can only yield a HostUnreachableError
    // in the page banner; the host-unreachable surface already says it better.
    if (this.isHostBlocked(sshHost)) return;
    try {
      const docker = await rpc.remoteSwitchServer.detectDocker(sshHost);
      runInAction(() => this.dockerByHost.set(sshHost, docker));
    } catch (cause) {
      this.setError(cause, 'Could not check Docker availability.');
    }
  }

  async start(sshHost: string, name: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
      this.errorDetail = null;
      this.logsByHost.set(sshHost, []);
    });
    try {
      const result = await rpc.remoteSwitchServer.start({ sshHost, name });
      if (result.kind === 'docker-unavailable') {
        runInAction(() => {
          this.dockerByHost.set(sshHost, {
            available: false,
            reason: result.reason,
            detail: result.detail,
          });
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
      runInAction(() => this.busyHosts.delete(sshHost));
    }
  }

  async stop(sshHost: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
      this.errorDetail = null;
    });
    try {
      await rpc.remoteSwitchServer.stop(sshHost);
    } catch (cause) {
      this.setError(cause, 'Could not stop the server.');
    } finally {
      runInAction(() => this.busyHosts.delete(sshHost));
    }
  }

  async reset(sshHost: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
      this.errorDetail = null;
    });
    try {
      // The reset deletes the stack's agents itself — their server-side
      // identity dies with it — so this only has to refresh what the deletion
      // changed underneath the UI.
      await rpc.remoteSwitchServer.reset(sshHost);
      await agentsStore.load();
      await switchServersStore.init();
    } catch (cause) {
      this.setError(cause, 'Could not reset the server.');
    } finally {
      runInAction(() => this.busyHosts.delete(sshHost));
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

export const remoteServerStore = new RemoteServerStore();
