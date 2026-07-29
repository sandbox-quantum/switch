import { makeAutoObservable, runInAction } from 'mobx';
import { agentsStore } from '@renderer/features/locations/stores/agents-store';
import { getLocationManagerStore } from '@renderer/features/locations/stores/location-selectors';
import { hostReachabilityStore } from '@renderer/features/remote-hosts/host-reachability-store';
import { events, rpc } from '@renderer/lib/ipc';
import type { DockerAvailability } from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type RemoteServerStatus,
  remoteServerLogChannel,
  remoteServerStatusChannel,
} from '@shared/events/remoteSwitchServerEvents';
import { switchServersStore } from './switch-servers-store';

const MAX_LOG_LINES = 400;

function defaultStatus(sshHost: string): RemoteServerStatus {
  return { sshHost, phase: 'stopped', serverId: null, version: '', message: null, error: null };
}

/**
 * Renderer store for remote-managed servers — one switchdash-run stack per SSH
 * host. Mirrors the main-process supervisor's per-host status (streamed over
 * `remoteServerStatusChannel`) and exposes the lifecycle actions keyed by host.
 * Structurally a per-host version of {@link LocalServerStore}.
 */
export class RemoteServerStore {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly logsByHost = new Map<string, string[]>();
  private readonly dockerByHost = new Map<string, DockerAvailability>();
  private readonly busyHosts = new Set<string>();
  error: string | null = null;

  private off: (() => void) | null = null;
  private offLog: (() => void) | null = null;

  constructor() {
    makeAutoObservable(this);
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
      this.offLog = events.on(remoteServerLogChannel, ({ sshHost, line }) => {
        runInAction(() => {
          const lines = this.logsByHost.get(sshHost) ?? [];
          lines.push(line);
          if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES);
          this.logsByHost.set(sshHost, lines);
        });
      });
    }
    try {
      const statuses = await rpc.remoteSwitchServer.getStatuses();
      runInAction(() => {
        for (const status of statuses) this.statuses.set(status.sshHost, status);
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

  async checkDocker(sshHost: string): Promise<void> {
    // Probing Docker over a dead SSH forward can only yield a HostUnreachableError
    // in the page banner; the host-unreachable surface already says it better.
    if (this.isHostBlocked(sshHost)) return;
    try {
      const docker = await rpc.remoteSwitchServer.detectDocker(sshHost);
      runInAction(() => this.dockerByHost.set(sshHost, docker));
    } catch (cause) {
      this.setError(cause);
    }
  }

  async start(sshHost: string, name: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
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
      runInAction(() => this.busyHosts.delete(sshHost));
    }
  }

  async stop(sshHost: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
    });
    try {
      await rpc.remoteSwitchServer.stop(sshHost);
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => this.busyHosts.delete(sshHost));
    }
  }

  async reset(sshHost: string, serverId: string): Promise<void> {
    runInAction(() => {
      this.busyHosts.add(sshHost);
      this.error = null;
    });
    try {
      // Remove the server's agents first (their server-side identity is wiped by
      // the reset), then destroy the stack.
      await this.removeManagedAgents(serverId);
      await rpc.remoteSwitchServer.reset(sshHost);
      await switchServersStore.init();
    } catch (cause) {
      this.setError(cause);
    } finally {
      runInAction(() => this.busyHosts.delete(sshHost));
    }
  }

  private async removeManagedAgents(serverId: string): Promise<void> {
    await agentsStore.load();
    const locationIds = new Set<string>();
    for (const [locationId, agents] of agentsStore.byLocation) {
      if (agents.some((a) => a.serverId === serverId)) locationIds.add(locationId);
    }
    const manager = getLocationManagerStore();
    for (const locationId of locationIds) {
      await manager.removeLocation(locationId);
    }
    await agentsStore.load();
  }

  private setError(cause: unknown): void {
    runInAction(() => {
      this.error = cause instanceof Error ? cause.message : String(cause);
    });
  }
}

export const remoteServerStore = new RemoteServerStore();
