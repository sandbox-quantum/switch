import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { deleteAgentsForServer } from '@main/core/switch-servers/delete-server-agents';
import {
  ensureManagedServer,
  getRemoteManagedServer,
  listManagedServers,
  removeServer,
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
  type ConnectRemoteServerResult,
  type DockerAvailability,
  type RemoteStackProbe,
  type StackActivityAction,
  type StackRegister,
  type StartLocalServerResult,
  managedServerUpgradeBlockedReason,
  matrixMigrationFailedMessage,
  othersRecentlySeen,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type RemoteServerStatus,
  remoteServerLogChannel,
  remoteServerStatusChannel,
} from '@shared/events/remoteSwitchServerEvents';
import { readRegister, writeRecord } from './console-register';
import { readVersionStatus } from './deployed-version';
import { apiUrlFor, gatewayUrlFor, type LocalServerPorts } from './free-port';
import { createRemoteServerHost, type RemoteServerHost } from './host/remote-host';
import { hostSlug, remoteSecretsKey } from './host/remote-identity';
import {
  owedUpgrade,
  readUpgradeJournal,
  type UpgradeJournal,
  upgradeState,
} from './managed-upgrade';
import { remoteServerStateDir } from './paths';
import {
  adoptRunningStack,
  type ConnectStackResult,
  connectStack,
  resetStack,
  startStack,
  stopStack,
} from './pipeline';
import { clearPorts } from './ports';
import { clearSecrets } from './secrets';
import {
  inspectStack,
  probeFromStack,
  type StackOnHost,
  type StackStateHost,
  unsharedStackMessage,
} from './stack-state';
import { readDeployedTelemetry } from './telemetry-consent';

/** How often a stack that stopped answering may be looked at again. The check
 * is an SSH round trip and a handful of `docker` calls, and it is prompted by
 * failing requests, which arrive in bursts. */
const RECHECK_INTERVAL_MS = 30_000;

/** How often picking a stack back up also records that this Console still
 * uses it. Every real action records it too; this only keeps a Console that
 * does nothing but use the server inside the register's two-week window,
 * without a container run on the host at every launch and re-check. */
const SIGHTING_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
    notice: null,
    recordWarning: null,
  };
}

const RECORDED_AS: Record<StackActivityAction, string> = {
  started: 'started it',
  connected: 'connected to it',
  stopped: 'stopped it',
  reset: 'reset it',
  disconnected: 'disconnected from it',
};

/** What the server page says when this Console's record of `action` could not
 * be written to the host — and what that costs the other people sharing it. */
function recordWarningFor(
  hostLabel: string,
  action: StackActivityAction | null,
  reason: string
): string {
  if (action === null) {
    return (
      `Could not record on ${hostLabel} that this Console uses the server, so others may not ` +
      `see it among its users: ${reason}`
    );
  }
  return (
    `This Console could not record on ${hostLabel} that it ${RECORDED_AS[action]}, so others ` +
    `using the server will not see that in its activity: ${reason}`
  );
}

/**
 * What to tell the user about a stack that is not running when this Console
 * looked, or null when there is nothing to say. `wasRunning` is whether this
 * Console last saw it up — a stack that was stopped from here needs no
 * explanation; one that stopped under us does.
 */
function noticeForIdleStack(
  hostLabel: string,
  stack: StackOnHost,
  wasRunning: boolean
): string | null {
  switch (stack.kind) {
    case 'present':
      return wasRunning
        ? `The server on ${hostLabel} was stopped outside this Console — from another Console, or on the host.`
        : null;
    case 'absent':
      return (
        `Nothing is set up on ${hostLabel} any more: the server was removed from another ` +
        `Console or on the host. Starting it sets up a new, empty one.`
      );
    case 'unshared':
      return unsharedStackMessage(hostLabel, stack.ownerDir);
    case 'incomplete':
      return `The server's settings on ${hostLabel} are missing ${stack.missing.join(', ')}.`;
    case 'unreadable':
      return `Could not read the server's settings on ${hostLabel}: ${stack.reason}`;
  }
}

/**
 * Supervises Switch Console-managed Switch stacks on remote hosts (one per SSH
 * alias), via the shared {@link startStack} pipeline on a {@link
 * RemoteServerHost}. Unlike the local service, a started host is KEPT ALIVE in
 * `hosts` because it owns the persistent port-forward that makes the stack
 * reachable from the desktop; it is disposed only on stop/reset/disconnect/
 * quit. The containers themselves run detached, so a remote stack (and its
 * remote-host agents) stays up while Switch Console is closed — only the
 * desktop-side forward goes away.
 *
 * A host whose stack is behind this build's switch-core pin is upgraded when it
 * is reconciled — at boot, and whenever the host becomes reachable again — and
 * {@link ensureReady} holds sessions for its agents until that has finished.
 *
 * A remote stack is shared by everyone with access to its host (CHOO-2893), so
 * this Console is one of possibly several supervising it. Its view is taken
 * from the host rather than remembered: at launch, when the host comes back,
 * and whenever the stack stops answering, the host is read again, so a stack
 * another Console stopped, restarted or reset is shown as it is.
 */
export class RemoteServerService {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly hosts = new Map<string, RemoteServerHost>();
  private readonly busy = new Set<string>();
  private readonly startAborts = new Map<string, AbortController>();
  private initialization: Promise<void> | null = null;
  /** The reconcile, start or connect in flight per host, which {@link ensureReady} waits out. */
  private readonly operations = new Map<string, Promise<void>>();
  /** The start in flight per host, which an automatic upgrade and a Start click share. */
  private readonly starting = new Map<string, Promise<StartLocalServerResult>>();
  private readonly upgradeListeners = new Set<(serverId: string) => void>();
  /** Hosts {@link ensureReady} has turned something away for since their last
   * upgrade finished, so that it can be told when they are ready. */
  private readonly refused = new Set<string>();
  private readonly lastRecheck = new Map<string, number>();
  /** When this Console last got a record onto each host. */
  private readonly lastRecorded = new Map<string, number>();

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

  /**
   * Record this Console, and what it did, on the stack's host. A record that
   * cannot be written does not undo or fail the operation it describes — the
   * stack was still started or stopped — so the failure is logged and shown on
   * the server page, where it stays until a later record succeeds.
   */
  private async record(
    sshHost: string,
    host: StackStateHost,
    action: StackActivityAction | null
  ): Promise<void> {
    try {
      await writeRecord(host, action);
      this.lastRecorded.set(sshHost, Date.now());
      this.setStatus(sshHost, { recordWarning: null });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.warn(
        `remote-switch-server: could not record ${action ?? 'this Console'} on ${host.label}`,
        {
          error,
        }
      );
      this.setStatus(sshHost, { recordWarning: recordWarningFor(host.label, action, reason) });
    }
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

  /**
   * What `sshHost` has of a stack, so the UI can offer the one action that is
   * safe there: Connect to a running one, Start a stopped or absent one, or
   * neither for one this account cannot read. Reads only.
   */
  async probe(sshHost: string): Promise<RemoteStackProbe> {
    hostReachabilityService.requireReachable(sshHost);
    const host = await createRemoteServerHost(sshHost);
    try {
      const docker = await host.detectDocker();
      if (!docker.available) {
        return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
      }
      return probeFromStack(host.label, await inspectStack(host));
    } finally {
      host.dispose();
    }
  }

  /** Who uses the stack on `sshHost` and what they last did to it, as the
   * Consoles sharing it have recorded on the host. Reads only. */
  async register(sshHost: string): Promise<StackRegister> {
    hostReachabilityService.requireReachable(sshHost);
    const live = this.hosts.get(sshHost);
    if (live) return readRegister(live);
    const host = await createRemoteServerHost(sshHost);
    try {
      return await readRegister(host);
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

  /**
   * Look at a stack that was running and has stopped answering, at most once
   * per {@link RECHECK_INTERVAL_MS}. Prompted by failing gateway calls: on a
   * shared host the likeliest reason is that another Console stopped,
   * restarted or reset the stack, and reading the host says which — rather
   * than every later call reporting a local port that was never the problem.
   * Fire-and-forget; the outcome arrives as a status.
   */
  recheck(sshHost: string): void {
    if (this.busy.has(sshHost)) return;
    if (this.getStatus(sshHost).phase !== 'running') return;
    if (hostReachabilityService.isBlocked(sshHost)) return;
    const now = Date.now();
    if (now - (this.lastRecheck.get(sshHost) ?? 0) < RECHECK_INTERVAL_MS) return;
    this.lastRecheck.set(sshHost, now);
    void this.track(sshHost, async () => {
      const server = (await this.remoteHosts()).get(sshHost);
      if (!server || this.busy.has(sshHost)) return;
      log.info(`remote-switch-server: ${sshHost} stopped answering; reading the host again`);
      await this.reconcileHost(sshHost, server);
    }).catch((error: unknown) => {
      log.warn(`remote-switch-server: re-check failed for ${sshHost}`, { error });
    });
  }

  /**
   * Read the host and take its stack up as it is. A running stack is adopted
   * with the settings the host holds — so a stack another Console restarted on
   * new ports is forwarded to the new ones, and its record follows — and a
   * stack that is not running is shown as stopped, saying why when this
   * Console did not stop it. Skipped while the host is blocked — the
   * reachability manager calls back through {@link onHostReachable} when it
   * recovers.
   *
   * Also records how the host's deployed switch-core compares to this build's
   * pin (CHOO-1736). A running stack that is behind, or one whose last upgrade
   * from this account was interrupted, is upgraded instead of adopted; a
   * stopped one that is behind is marked to be upgraded at its next start. On a
   * shared host that upgrade is for everyone, like any start. The check runs
   * even when the stack is down: its data volumes still hold the schema the
   * last version migrated to, which is what makes a downgrade unsafe.
   */
  private async reconcileHost(
    sshHost: string,
    server: { id: string; name: string }
  ): Promise<void> {
    if (hostReachabilityService.isBlocked(sshHost)) return;
    // Checked here, with no await before the add, and not only by the callers:
    // they look before awaiting the server list, and a Start clicked in that
    // gap must not have this read run beside it and give back its flag.
    if (this.busy.has(sshHost)) return;
    const wasRunning = this.getStatus(sshHost).phase === 'running';
    this.busy.add(sshHost);
    // The forward this Console holds stays until the host gives an answer that
    // replaces it: a failure to ask says nothing about the stack, and dropping
    // the forward on one would strand a server that is still up.
    const live = this.hosts.get(sshHost) ?? null;
    let host: RemoteServerHost | null = null;
    let kept = false;
    let upgradeNow = false;
    try {
      host = await createRemoteServerHost(sshHost);
      const stack = await inspectStack(host);
      if (stack.kind === 'unreadable') {
        this.leaveUnanswered(sshHost, wasRunning, stack.reason);
        return;
      }
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
      // Only a stack this account can start from the host's own settings: an
      // upgrade is a start, and a start is refused for anything else.
      upgradeNow = owed !== null && stack.kind === 'present' && (stack.running || journal !== null);
      // Updating a running stack restarts it for everyone using it, so one that
      // others have used lately is not updated under them unasked (CHOO-2893);
      // it waits for someone here to run it. An update this account already
      // started is resumed: it is past asking, and the stack is half-migrated.
      const held = upgradeNow && journal === null && (await this.othersUseIt(sshHost, host));
      if (held) upgradeNow = false;
      if (upgradeNow) {
        // The start replaces this Console's forward, if it holds one.
      } else if (stack.kind === 'present' && stack.running) {
        const settings = await adoptRunningStack(host, stack);
        const moved = await this.followPorts(sshHost, server.id, settings.ports);
        if (!live || moved) {
          this.releaseHost(sshHost, live);
          await host.establishNetworking(settings.ports);
          this.hosts.set(sshHost, host);
          kept = true;
        }
        this.setStatus(sshHost, {
          phase: 'running',
          serverId: server.id,
          error: null,
          notice: null,
        });
        // Only for a running stack: a stopped one sends nothing, so it
        // cannot be out of step with the user's answer.
        this.setStatus(sshHost, { deployedTelemetry: await readDeployedTelemetry(host) });
        if (Date.now() - (this.lastRecorded.get(sshHost) ?? 0) >= SIGHTING_INTERVAL_MS) {
          await this.record(sshHost, host, null);
        }
      } else {
        this.releaseHost(sshHost, live);
        this.setStatus(sshHost, {
          phase: 'stopped',
          serverId: server.id,
          deployedTelemetry: null,
          notice: noticeForIdleStack(host.label, stack, wasRunning),
        });
      }
      this.setStatus(sshHost, {
        ...version,
        upgrade: owed && (held ? { state: 'held', ...owed } : upgradeState(owed, upgradeNow)),
      });
    } catch (error) {
      log.warn(`remote-switch-server: reconcile failed for ${sshHost}`, { error });
      this.leaveUnanswered(
        sshHost,
        wasRunning,
        error instanceof Error ? error.message : String(error)
      );
    } finally {
      // A host that became the live one owns its forward; any other is throwaway.
      if (!kept) host?.dispose();
      this.busy.delete(sshHost);
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

  /**
   * Whether other Consoles have used the stack on `host` lately, by the
   * register they keep there. One that cannot be read is taken as yes: an
   * update is asked about when there is no telling who it would reach.
   */
  private async othersUseIt(sshHost: string, host: RemoteServerHost): Promise<boolean> {
    try {
      return othersRecentlySeen(await readRegister(host), new Date()).length > 0;
    } catch (error) {
      log.warn(`remote-switch-server: could not read who uses the server on ${sshHost}`, {
        error,
      });
      return true;
    }
  }

  /**
   * The host could not be asked what it has. That is not news about the stack,
   * so a stack this Console saw running keeps its forward and its phase, and
   * says it could not be checked; the next failing call asks again.
   */
  private leaveUnanswered(sshHost: string, wasRunning: boolean, reason: string): void {
    log.warn(`remote-switch-server: could not check the stack on ${sshHost}`, { reason });
    if (wasRunning) {
      this.setStatus(sshHost, { notice: `Could not check the server on ${sshHost}: ${reason}` });
    }
  }

  /** Point the server's record at the ports the stack actually publishes,
   * when another Console has restarted it on different ones. Returns whether
   * they moved — the record holds the ports this Console forwards. */
  private async followPorts(
    sshHost: string,
    serverId: string,
    ports: LocalServerPorts
  ): Promise<boolean> {
    const gatewayUrl = gatewayUrlFor(ports);
    const apiUrl = apiUrlFor(ports);
    const record = await getRemoteManagedServer(sshHost);
    if (!record || (record.gatewayUrl === gatewayUrl && record.apiUrl === apiUrl)) return false;
    log.info(`remote-switch-server: the stack on ${sshHost} now publishes different ports`, {
      serverId,
      from: record.gatewayUrl,
      to: gatewayUrl,
    });
    await ensureManagedServer(
      { name: record.name, gatewayUrl, apiUrl },
      { kind: 'remote', sshHost }
    );
    return true;
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
        notice: null,
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
        await this.record(sshHost, host, 'started');
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

  /**
   * Join the stack already running on `sshHost`, started by another Console
   * or another account (CHOO-2893). Nothing on the host changes: see
   * {@link connectStack}. The host is kept on success for the same reason a
   * started one is — it owns the forward.
   */
  connect(sshHost: string, serverName: string): Promise<ConnectRemoteServerResult> {
    return this.track(sshHost, async () => {
      const result = await this.runConnect(sshHost, serverName);
      return result.kind === 'behind' ? this.connectByUpdating(sshHost, serverName) : result;
    });
  }

  private async runConnect(sshHost: string, serverName: string): Promise<ConnectStackResult> {
    if (this.busy.has(sshHost)) {
      return { kind: 'error', message: `An operation is already in progress for ${sshHost}.` };
    }
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const abort = new AbortController();
    this.startAborts.set(sshHost, abort);
    this.releaseHost(sshHost, this.hosts.get(sshHost) ?? null);
    let host: RemoteServerHost | null = null;
    try {
      this.setStatus(sshHost, {
        phase: 'starting',
        error: null,
        notice: null,
        message: `Connecting to ${sshHost}…`,
      });
      host = await createRemoteServerHost(sshHost);
      const result = await connectStack({
        host,
        ref: { kind: 'remote', sshHost },
        serverName,
        onMessage: (message) => this.setStatus(sshHost, { message }),
        signal: abort.signal,
      });
      if (result.kind === 'connected') {
        this.hosts.set(sshHost, host);
        this.setStatus(sshHost, {
          phase: 'running',
          serverId: result.serverId,
          message: null,
          error: null,
        });
        this.setStatus(sshHost, await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION));
        this.setStatus(sshHost, { deployedTelemetry: await readDeployedTelemetry(host) });
        await this.record(sshHost, host, 'connected');
        return result;
      }
      host.dispose();
      if (result.kind === 'behind') {
        this.setStatus(sshHost, {
          message: `Updating the server from switch-core ${result.deployed} to ${result.expected}…`,
        });
      } else if (result.kind === 'not-running' || result.kind === 'absent') {
        this.setStatus(sshHost, { phase: 'stopped', message: null });
      } else if (result.kind === 'docker-unavailable') {
        this.setStatus(sshHost, { phase: 'error', message: null, error: result.detail });
      } else {
        this.setStatus(sshHost, { phase: 'error', message: null, error: result.message });
      }
      return result;
    } catch (error) {
      host?.dispose();
      const message = error instanceof Error ? error.message : String(error);
      log.error(`remote-switch-server: connect failed for ${sshHost}`, { error });
      this.setStatus(sshHost, { phase: 'error', message: null, error: message });
      return { kind: 'error', message };
    } finally {
      this.busy.delete(sshHost);
      this.startAborts.delete(sshHost);
    }
  }

  /**
   * Join a stack that runs an older switch-core than this build pins, which
   * this Console cannot use as it is, by updating it. That is a start — from
   * the stack's own settings, with its database backed up first — and, like
   * any start on a shared host, an update for everyone using it, which the
   * connect step says before it is clicked.
   */
  private async connectByUpdating(
    sshHost: string,
    serverName: string
  ): Promise<ConnectRemoteServerResult> {
    const result = await this.beginStart(sshHost, serverName, true);
    switch (result.kind) {
      case 'started':
        return {
          kind: 'connected',
          serverId: result.serverId,
          deployedVersion: COMPATIBLE_SWITCH_VERSION,
        };
      case 'docker-unavailable':
      case 'error':
        return result;
      case 'version-downgrade':
        return {
          kind: 'error',
          message: switchVersionDowngradeMessage(result.deployed, result.expected),
        };
      case 'matrix-migration-failed':
        return {
          kind: 'error',
          message: matrixMigrationFailedMessage(result.deployed, result.expected),
        };
    }
  }

  /**
   * Stop using the stack on `sshHost` from this Console, leaving it running
   * for everyone else (CHOO-2893): close the forward, remove the server
   * record — its agents are unlinked and kept, as for any server — and drop
   * this desktop's copy of the stack's credentials, which it no longer needs.
   * Nothing on the host is touched, so this needs no connection.
   */
  async disconnect(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost))
      throw new Error(`An operation is already in progress for ${sshHost}.`);
    this.busy.add(sshHost);
    try {
      // Said on the host only when this Console is still connected to it:
      // leaving must not wait on, or fail for, a host that is out of reach.
      const live = this.hosts.get(sshHost) ?? null;
      if (live && !hostReachabilityService.isBlocked(sshHost)) {
        // Logged only: the server leaves this Console with the disconnect, so
        // there is no page left to show a failure on.
        await writeRecord(live, 'disconnected').catch((error) => {
          log.warn(`remote-switch-server: could not record disconnected on ${live.label}`, {
            error,
          });
        });
      }
      this.releaseHost(sshHost, live);
      const server = await getRemoteManagedServer(sshHost);
      if (server) await removeServer(server.id);
      await clearSecrets({ secretsKey: remoteSecretsKey(sshHost) });
      await clearPorts({ stateDir: remoteServerStateDir(hostSlug(sshHost)) });
      this.setStatus(sshHost, initialStatus(sshHost));
      this.statuses.delete(sshHost);
      this.lastRecheck.delete(sshHost);
      this.lastRecorded.delete(sshHost);
    } finally {
      this.busy.delete(sshHost);
    }
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
        notice: null,
        deployedTelemetry: null,
        upgrade: upgrade && upgradeState(upgrade, false),
      });
      await this.record(sshHost, host, 'stopped');
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
        notice: null,
        deployedTelemetry: null,
        deployedVersion: null,
        drift: null,
        upgrade: null,
      });
      // Kept through the reset on purpose: who destroyed a shared server is
      // exactly what its other users will ask.
      await this.record(sshHost, host, 'reset');
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
   * Drop the host an operation used, and the map entry it may have come from.
   *
   * Null when the operation never got one — the alias is then left alone
   * rather than un-keyed, because an entry dropped without being disposed
   * strands the port-forward it owns and lets the reachability reconciler adopt
   * the same stack a second time.
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
