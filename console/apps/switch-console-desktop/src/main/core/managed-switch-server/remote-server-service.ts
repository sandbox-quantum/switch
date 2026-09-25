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
  reportManagedServerStartThrew,
} from '@main/core/telemetry/managed-server';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  type DockerAvailability,
  type StartLocalServerResult,
  managedServerUpgradeBlockedReason,
  matrixMigrationFailedMessage,
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
import {
  owedUpgrade,
  readUpgradeJournal,
  type UpgradeJournal,
  upgradeState,
} from './managed-upgrade';
import { resetStack, startStack, stopStack } from './pipeline';
import { readPersistedPorts } from './ports';
import { readDeployedTelemetry } from './telemetry-consent';

function initialStatus(sshHost: string): RemoteServerStatus {
  return {
    sshHost,
    phase: 'stopped',
    upgrade: null,
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    // A remote host builds nothing: its stack always runs the pinned released
    // images, so the dev checkout option is not on offer there.
    checkoutBuild: null,
    deployedTelemetry: null,
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
 *
 * A host whose stack is behind this build's switch-core pin is upgraded when it
 * is reconciled — at boot, and whenever the host becomes reachable again — and
 * {@link ensureReady} holds sessions for its agents until that has finished.
 */
export class RemoteServerService {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly hosts = new Map<string, RemoteServerHost>();
  private readonly busy = new Set<string>();
  private readonly startAborts = new Map<string, AbortController>();
  private initialization: Promise<void> | null = null;
  /** The reconcile or start in flight per host, which {@link ensureReady} waits out. */
  private readonly operations = new Map<string, Promise<void>>();
  /** The start in flight per host, which an automatic upgrade and a Start click share. */
  private readonly starting = new Map<string, Promise<StartLocalServerResult>>();
  private readonly upgradeListeners = new Set<(serverId: string) => void>();
  /** Hosts {@link ensureReady} has turned something away for since their last
   * upgrade finished, so that it can be told when they are ready. */
  private readonly refused = new Set<string>();

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
   * quit, so their desktop reachability is restored on launch, and upgrade the
   * ones that are behind. Hosts reconcile independently and in the background;
   * an unreachable one is left `stopped` rather than failing boot.
   *
   * Memoised: {@link ensureReady} awaits the same call. It resolves once every
   * host's reconcile is registered, not once they are done. */
  initialize(): Promise<void> {
    this.initialization ??= this.startReconciling();
    return this.initialization;
  }

  private async startReconciling(): Promise<void> {
    // Registered before the first await, so the host's reconcile is in flight
    // before anything else that reacts to the same recovery asks whether the
    // server is ready.
    hostReachabilityService.on('change', ({ current }: HostReachabilityChange) => {
      if (current.status !== 'reachable') return;
      void this.track(current.sshHost, () => this.onHostReachable(current.sshHost)).catch(
        (error: unknown) => {
          log.warn(`remote-switch-server: reconcile after recovery failed for ${current.sshHost}`, {
            error,
          });
        }
      );
    });
    for (const [sshHost, server] of await this.remoteHosts()) {
      this.statuses.set(sshHost, initialStatus(sshHost));
      void this.track(sshHost, () => this.reconcileHost(sshHost, server));
    }
  }

  private async remoteHosts(): Promise<Map<string, { id: string; name: string }>> {
    const remotes = (await listManagedServers()).filter(
      (s) => s.managementKind === 'remote' && s.sshHost
    );
    return new Map(remotes.map((s) => [s.sshHost!, { id: s.id, name: s.name }]));
  }

  /** Remember `run` as the host's operation in flight until it settles. */
  private track<T>(sshHost: string, run: () => Promise<T>): Promise<T> {
    const promise = run();
    const settled = promise.then(
      () => undefined,
      () => undefined
    );
    this.operations.set(sshHost, settled);
    void settled.then(() => {
      if (this.operations.get(sshHost) === settled) this.operations.delete(sshHost);
    });
    return promise;
  }

  /**
   * Resolves once sessions may run against the stack on `sshHost`, waiting out
   * its reconcile and any upgrade in flight. Throws when it still owes an
   * upgrade — stopped, or failed — with the reason to show.
   */
  async ensureReady(sshHost: string, serverName: string): Promise<void> {
    await this.initialize();
    for (let op = this.operations.get(sshHost); op; op = this.operations.get(sshHost)) await op;
    const upgrade = this.getStatus(sshHost).upgrade;
    if (upgrade === null) return;
    if (upgrade.state === 'updating') {
      throw new Error(`${serverName} reports an update in progress, but none is running.`);
    }
    this.refused.add(sshHost);
    throw new Error(managedServerUpgradeBlockedReason(serverName, upgrade));
  }

  /** Called with the server id when an upgrade finishes that sessions or
   * watchers were turned away for (a failed one retried, or a stopped one
   * started). Those that waited instead carry on by themselves. */
  onUpgradeFinished(listener: (serverId: string) => void): void {
    this.upgradeListeners.add(listener);
  }

  /** Pick a host's stack back up once its host is reachable again, so a
   * recovered host resumes — and catches up on an owed upgrade — without the
   * user restarting anything. */
  private async onHostReachable(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost) || this.hosts.has(sshHost)) return;
    const server = (await this.remoteHosts()).get(sshHost);
    if (!server) return;
    await this.reconcileHost(sshHost, server);
  }

  /** Adopt an already-running remote stack: re-open its forward and mark it
   * running. Skipped while the host is blocked — the reachability manager will
   * call back through {@link onHostReachable} when it recovers.
   *
   * Also records how the host's deployed switch-core compares to this build's
   * pin (CHOO-1736). A running stack that is behind, or one whose last upgrade
   * was interrupted, is upgraded instead of adopted; a stopped one that is
   * behind is marked to be upgraded at its next start. The check runs even
   * when the stack is down: its data volumes still hold the schema the last
   * version migrated to, which is what makes a downgrade unsafe. */
  private async reconcileHost(
    sshHost: string,
    server: { id: string; name: string }
  ): Promise<void> {
    if (hostReachabilityService.isBlocked(sshHost)) return;
    let host: RemoteServerHost | null = null;
    let adopted = false;
    let upgradeNow = false;
    try {
      host = await createRemoteServerHost(sshHost);
      const running = await isStackRunning(host);
      const version = await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION);
      let journal: UpgradeJournal | null;
      try {
        journal = await readUpgradeJournal(host);
      } catch (error) {
        this.setStatus(sshHost, {
          ...version,
          upgrade: {
            state: 'failed',
            from: version.deployedVersion ?? 'an unknown version',
            to: COMPATIBLE_SWITCH_VERSION,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const owed = owedUpgrade(version.drift, journal);
      upgradeNow = owed !== null && (running || journal !== null);
      if (running && !upgradeNow) {
        const ports = await readPersistedPorts(host);
        if (ports) {
          await host.establishNetworking(ports);
          this.hosts.set(sshHost, host);
          adopted = true;
          this.setStatus(sshHost, { phase: 'running', serverId: server.id });
          // Only for a running stack: a stopped one sends nothing, so it
          // cannot be out of step with the user's answer.
          this.setStatus(sshHost, { deployedTelemetry: await readDeployedTelemetry(host) });
        }
        // Running but we don't know its ports — leave it stopped; the user can
        // restart to re-derive them rather than forward to the wrong ports.
      }
      this.setStatus(sshHost, { ...version, upgrade: owed && upgradeState(owed, upgradeNow) });
    } catch (error) {
      log.warn(`remote-switch-server: boot reconcile failed for ${sshHost}`, { error });
    } finally {
      // The adopted host owns the live port-forward; anything else is throwaway.
      if (!adopted) host?.dispose();
    }
    if (!upgradeNow) return;
    try {
      await this.beginStart(sshHost, server.name, false);
    } catch (error) {
      // Only the reachability check throws rather than reporting a result.
      log.warn(`remote-switch-server: could not upgrade ${sshHost}`, { error });
      this.failUpgrade(sshHost, error instanceof Error ? error.message : String(error));
    }
  }

  /** Start (or restart) the host's stack at this build's pin, upgrading it
   * first if it is behind. Joins a start already in flight for the host. */
  start(sshHost: string, serverName: string): Promise<StartLocalServerResult> {
    return this.track(sshHost, () => this.beginStart(sshHost, serverName, true));
  }

  private beginStart(
    sshHost: string,
    serverName: string,
    activate: boolean
  ): Promise<StartLocalServerResult> {
    const inFlight = this.starting.get(sshHost);
    if (inFlight) return inFlight;
    const run = this.runStart(sshHost, serverName, activate).finally(() => {
      this.starting.delete(sshHost);
    });
    this.starting.set(sshHost, run);
    return run;
  }

  private async runStart(
    sshHost: string,
    serverName: string,
    activate: boolean
  ): Promise<StartLocalServerResult> {
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
        activate,
        onMessage: (message) => this.setStatus(sshHost, { message }),
        onLog: (line) => events.emit(remoteServerLogChannel, { sshHost, line }),
        onUpgrade: (owed) => this.setStatus(sshHost, { upgrade: upgradeState(owed, true) }),
        signal: abort.signal,
        checkoutRoot: null,
      });
      if (result.kind === 'docker-unavailable') {
        this.setStatus(sshHost, { phase: 'error', error: result.detail });
        this.failUpgrade(sshHost, result.detail);
        host.dispose();
      } else if (result.kind === 'version-downgrade') {
        this.setStatus(sshHost, {
          phase: 'error',
          message: null,
          error: switchVersionDowngradeMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
          drift: { deployed: result.deployed, expected: result.expected, direction: 'downgrade' },
          upgrade: null,
        });
        host.dispose();
      } else if (result.kind === 'matrix-migration-failed') {
        const error = matrixMigrationFailedMessage(result.deployed, result.expected);
        this.setStatus(sshHost, {
          phase: 'error',
          message: null,
          error,
          deployedVersion: result.deployed,
        });
        this.failUpgrade(sshHost, error);
      } else if (result.kind === 'error') {
        this.setStatus(sshHost, { phase: 'error', error: result.message });
        this.failUpgrade(sshHost, result.message);
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
          upgrade: null,
          deployedTelemetry: { known: true, enabled: result.telemetryEnabled },
        });
        if (this.refused.delete(sshHost)) {
          for (const listener of this.upgradeListeners) listener(result.serverId);
        }
      }
      reportManagedServerStart('remote', result);
      return result;
    } catch (error) {
      host?.dispose();
      const message = error instanceof Error ? error.message : String(error);
      log.error(`remote-switch-server: start failed for ${sshHost}`, { error });
      this.setStatus(sshHost, { phase: 'error', error: message });
      this.failUpgrade(sshHost, message);
      reportManagedServerStartThrew('remote');
      return { kind: 'error', message };
    } finally {
      this.busy.delete(sshHost);
      this.startAborts.delete(sshHost);
    }
  }

  /** Record why a host's upgrade did not finish. A start that was not an
   * upgrade has nothing to record here; its error is on the status already. */
  private failUpgrade(sshHost: string, error: string): void {
    const upgrade = this.getStatus(sshHost).upgrade;
    if (!upgrade) return;
    this.setStatus(sshHost, {
      upgrade: { state: 'failed', from: upgrade.from, to: upgrade.to, error },
    });
  }

  async stop(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost))
      throw new Error(`An operation is already in progress for ${sshHost}.`);
    this.busy.add(sshHost);
    // Reaching the host is part of stopping it, and the part that most often
    // fails: a stack is torn down because its host is misbehaving. Both steps
    // therefore sit inside the region that reports, and inside the one that
    // gives the busy flag back.
    let host: RemoteServerHost | null = null;
    try {
      hostReachabilityService.requireReachable(sshHost);
      host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
      this.setStatus(sshHost, { phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host);
      const upgrade = this.getStatus(sshHost).upgrade;
      this.setStatus(sshHost, {
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        upgrade: upgrade && upgradeState(upgrade, false),
      });
      reportManagedServerOutcome('stop', 'remote', 'success');
    } catch (error) {
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('stop', 'remote', 'failure');
      throw error;
    } finally {
      this.releaseHost(sshHost, host);
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
    this.busy.add(sshHost);
    // Reaching the host is inside the reported region for the reason `stop`
    // gives.
    let host: RemoteServerHost | null = null;
    try {
      hostReachabilityService.requireReachable(sshHost);
      host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
      this.setStatus(sshHost, { phase: 'stopping', message: 'Removing agents…' });
      const server = await getRemoteManagedServer(sshHost);
      if (server) await deleteAgentsForServer(server.id);
      this.setStatus(sshHost, { phase: 'stopping', message: 'Destroying containers and data…' });
      await resetStack(host);
      this.setStatus(sshHost, {
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        deployedVersion: null,
        drift: null,
        upgrade: null,
      });
      reportManagedServerOutcome('reset', 'remote', 'success');
    } catch (error) {
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('reset', 'remote', 'failure');
      throw error;
    } finally {
      this.releaseHost(sshHost, host);
      this.busy.delete(sshHost);
    }
  }

  /**
   * Drop the host a teardown used, and the map entry it may have come from.
   *
   * Null when the teardown never got one — the alias is then left alone rather
   * than un-keyed, because an entry dropped without being disposed strands the
   * port-forward it owns and lets the reachability reconciler adopt the same
   * stack a second time.
   */
  private releaseHost(sshHost: string, host: RemoteServerHost | null): void {
    if (!host) return;
    host.dispose();
    this.hosts.delete(sshHost);
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
