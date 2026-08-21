import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { deleteAgentsForServer } from '@main/core/switch-servers/delete-server-agents';
import {
  getRemoteManagedServer,
  listManagedServers,
} from '@main/core/switch-servers/servers-store';
import {
  reportManagedServerOutcome,
  reportManagedServerStart,
} from '@main/core/telemetry/managed-server';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  type DockerAvailability,
  type StartLocalServerResult,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type RemoteServerStatus,
  remoteServerLogChannel,
  remoteServerStatusChannel,
} from '@shared/events/remoteSwitchServerEvents';
import { isStackRunning } from './compose';
import { readVersionStatus } from './deployed-version';
import { createRemoteServerHost, type RemoteServerHost } from './host/remote-host';
import { resetStack, startStack, stopStack } from './pipeline';
import { readPersistedPorts } from './ports';

function initialStatus(sshHost: string): RemoteServerStatus {
  return {
    sshHost,
    phase: 'stopped',
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    // A remote host builds nothing: its stack always runs the pinned released
    // images, so the dev checkout option is not on offer there.
    checkoutBuild: null,
    message: null,
    error: null,
  };
}

/**
 * Supervises Switch Console-managed Switch stacks on remote hosts (one per SSH
 * alias), via the shared {@link startStack} pipeline on a {@link
 * RemoteServerHost}. Unlike the local service, a started host is KEPT ALIVE in
 * `hosts` because it owns the persistent port-forward that makes the stack
 * reachable from the desktop; it is disposed only on stop/reset/quit. The
 * containers themselves run detached, so a remote stack (and its remote-host
 * agents) stays up while Switch Console is closed — only the desktop-side forward
 * goes away.
 */
class RemoteServerService {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly hosts = new Map<string, RemoteServerHost>();
  private readonly busy = new Set<string>();
  private readonly startAborts = new Map<string, AbortController>();

  getStatuses(): RemoteServerStatus[] {
    return [...this.statuses.values()];
  }

  getStatus(sshHost: string): RemoteServerStatus {
    return this.statuses.get(sshHost) ?? initialStatus(sshHost);
  }

  private setStatus(sshHost: string, patch: Partial<RemoteServerStatus>): void {
    const next = { ...this.getStatus(sshHost), ...patch, sshHost };
    this.statuses.set(sshHost, next);
    events.emit(remoteServerStatusChannel, next);
  }

  async detectDocker(sshHost: string): Promise<DockerAvailability> {
    hostReachabilityService.requireReachable(sshHost);
    const host = await createRemoteServerHost(sshHost);
    try {
      return await host.detectDocker();
    } finally {
      host.dispose();
    }
  }

  /** Re-establish forwards + status for remote stacks that survived the last
   * quit, so their desktop reachability is restored on launch. Best-effort per
   * host: an unreachable host is left `stopped` rather than failing boot. */
  async initialize(): Promise<void> {
    hostReachabilityService.on('change', ({ current }: HostReachabilityChange) => {
      if (current.status === 'reachable') void this.onHostReachable(current.sshHost);
    });
    for (const [sshHost, serverId] of await this.remoteHosts()) {
      this.statuses.set(sshHost, initialStatus(sshHost));
      await this.reconcileHost(sshHost, serverId);
    }
  }

  private async remoteHosts(): Promise<Map<string, string>> {
    const remotes = (await listManagedServers()).filter(
      (s) => s.managementKind === 'remote' && s.sshHost
    );
    return new Map(remotes.map((s) => [s.sshHost!, s.id]));
  }

  /** Pick a host's stack back up once its host is reachable again, so a
   * recovered host resumes without the user restarting anything. */
  private async onHostReachable(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost) || this.hosts.has(sshHost)) return;
    const serverId = (await this.remoteHosts()).get(sshHost);
    if (!serverId) return;
    await this.reconcileHost(sshHost, serverId);
  }

  /** Adopt an already-running remote stack: re-open its forward and mark it
   * running. Skipped while the host is blocked — the reachability manager will
   * call back through {@link onHostReachable} when it recovers.
   *
   * Also records how the host's deployed switch-core compares to this build's
   * pin, so an app update that moved the pin surfaces as drift rather than
   * leaving the host on a stale core (CHOO-1736). That check runs even when the
   * stack is down: its data volumes still hold the schema the last version
   * migrated to, which is what makes a downgrade unsafe. */
  private async reconcileHost(sshHost: string, serverId: string): Promise<void> {
    if (hostReachabilityService.isBlocked(sshHost)) return;
    let host: RemoteServerHost | null = null;
    let adopted = false;
    try {
      host = await createRemoteServerHost(sshHost);
      if (await isStackRunning(host)) {
        const ports = await readPersistedPorts(host);
        if (ports) {
          await host.establishNetworking(ports);
          this.hosts.set(sshHost, host);
          adopted = true;
          this.setStatus(sshHost, { phase: 'running', serverId });
        }
        // Running but we don't know its ports — leave it stopped; the user can
        // restart to re-derive them rather than forward to the wrong ports.
      }
      this.setStatus(sshHost, await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION));
    } catch (error) {
      log.warn(`remote-switch-server: boot reconcile failed for ${sshHost}`, { error });
    } finally {
      // The adopted host owns the live port-forward; anything else is throwaway.
      if (!adopted) host?.dispose();
    }
  }

  async start(sshHost: string, serverName: string): Promise<StartLocalServerResult> {
    if (this.busy.has(sshHost)) {
      return { kind: 'error', message: `An operation is already in progress for ${sshHost}.` };
    }
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const abort = new AbortController();
    this.startAborts.set(sshHost, abort);
    // Replace any prior live host (and its forward) for this alias.
    this.hosts.get(sshHost)?.dispose();
    this.hosts.delete(sshHost);
    let host: RemoteServerHost | null = null;
    try {
      this.setStatus(sshHost, {
        phase: 'starting',
        error: null,
        message: `Connecting to ${sshHost}…`,
      });
      host = await createRemoteServerHost(sshHost);
      this.setStatus(sshHost, { message: 'Checking Docker…' });
      const result = await startStack({
        host,
        ref: { kind: 'remote', sshHost },
        serverName,
        onMessage: (message) => this.setStatus(sshHost, { message }),
        onLog: (line) => events.emit(remoteServerLogChannel, { sshHost, line }),
        signal: abort.signal,
        checkoutRoot: null,
      });
      if (result.kind === 'docker-unavailable') {
        this.setStatus(sshHost, { phase: 'error', error: result.detail });
        host.dispose();
      } else if (result.kind === 'version-downgrade') {
        this.setStatus(sshHost, {
          phase: 'error',
          message: null,
          error: switchVersionDowngradeMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
          drift: { deployed: result.deployed, expected: result.expected, direction: 'downgrade' },
        });
        host.dispose();
      } else if (result.kind === 'error') {
        this.setStatus(sshHost, { phase: 'error', error: result.message });
        host.dispose();
      } else {
        // Keep the host alive — it owns the port-forward.
        this.hosts.set(sshHost, host);
        // The pipeline just converged the containers onto this build's pin, so
        // any drift the boot probe found is now resolved.
        this.setStatus(sshHost, {
          phase: 'running',
          serverId: result.serverId,
          message: null,
          error: null,
          deployedVersion: COMPATIBLE_SWITCH_VERSION,
          drift: null,
        });
      }
      reportManagedServerStart('remote', result);
      return result;
    } catch (error) {
      host?.dispose();
      const message = error instanceof Error ? error.message : String(error);
      log.error(`remote-switch-server: start failed for ${sshHost}`, { error });
      this.setStatus(sshHost, { phase: 'error', error: message });
      const thrown: StartLocalServerResult = { kind: 'error', message };
      reportManagedServerStart('remote', thrown);
      return thrown;
    } finally {
      this.busy.delete(sshHost);
      this.startAborts.delete(sshHost);
    }
  }

  async stop(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost))
      throw new Error(`An operation is already in progress for ${sshHost}.`);
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
    try {
      this.setStatus(sshHost, { phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host);
      this.setStatus(sshHost, { phase: 'stopped', message: null, error: null });
      reportManagedServerOutcome('stop', 'remote', 'success');
    } catch (error) {
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('stop', 'remote', 'failure');
      throw error;
    } finally {
      host.dispose();
      this.hosts.delete(sshHost);
      this.busy.delete(sshHost);
    }
  }

  /** Destroy the remote stack, its data volumes, and stored secrets.
   *
   * The stack's agents are deleted first, here rather than in the caller — the
   * wipe destroys their server-side identity, so leaving them behind strands a
   * dead endpoint and a token for nobody (see {@link deleteAgentsForServer}). */
  async reset(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost))
      throw new Error(`An operation is already in progress for ${sshHost}.`);
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
    try {
      this.setStatus(sshHost, { phase: 'stopping', message: 'Removing agents…' });
      const server = await getRemoteManagedServer(sshHost);
      if (server) await deleteAgentsForServer(server.id);
      this.setStatus(sshHost, { phase: 'stopping', message: 'Destroying containers and data…' });
      await resetStack(host);
      this.setStatus(sshHost, { phase: 'stopped', message: null, error: null });
      reportManagedServerOutcome('reset', 'remote', 'success');
    } catch (error) {
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('reset', 'remote', 'failure');
      throw error;
    } finally {
      host.dispose();
      this.hosts.delete(sshHost);
      this.busy.delete(sshHost);
    }
  }

  /** Abort in-flight health waits and drop all forwards (app quit). The remote
   * containers keep running; only the desktop-side tunnels close. */
  dispose(): void {
    for (const abort of this.startAborts.values()) abort.abort();
    this.startAborts.clear();
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
  }
}

export const remoteServerService = new RemoteServerService();
