import type { HostReachabilityChange } from '@main/core/remote-hosts/host-reachability-service';
import { hostReachabilityService } from '@main/core/remote-hosts/production-host-reachability';
import { getConsoleIdentity } from '@main/core/switch-servers/console-identity';
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
import { KV } from '@main/db/kv';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  type ConnectRemoteServerResult,
  type DockerAvailability,
  type RemoteStackProbe,
  type ServerLockAction,
  type ServerLockHolder,
  type StackActivityAction,
  type StackRegister,
  type StartRemoteServerResult,
  managedServerUpgradeBlockedReason,
  matrixMigrationFailedMessage,
  othersRecentlySeen,
  stoppedWaitingForLockMessage,
  switchVersionDowngradeMessage,
  waitingForLockMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  type RemoteServerStatus,
  remoteServerLogChannel,
  remoteServerStatusChannel,
} from '@shared/events/remoteSwitchServerEvents';
import { hostAccount, readRegister, writeRecord } from './console-register';
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
  bringWorkingDirInStep,
  type ConnectStackResult,
  connectStack,
  resetStack,
  startStack,
  stopStack,
} from './pipeline';
import { clearPorts } from './ports';
import { clearSecrets } from './secrets';
import {
  acquireServerLock,
  CONSOLE_INSTANCE,
  type LockClaim,
  readServerLock,
  SERVER_LOCK_TIMING,
  type ServerLease,
  ServerLockWaitCancelled,
} from './stack-lock';
import {
  inspectStack,
  probeFromStack,
  stateVolumeExists,
  type StackOnHost,
  type StackStateHost,
  unsharedStackMessage,
} from './stack-state';
import { readDeployedTelemetry } from './telemetry-consent';

/** Minimum gap between re-reads of a stack that stopped answering: each is an
 * SSH round trip plus `docker` calls, prompted by failing requests that burst. */
const RECHECK_INTERVAL_MS = 30_000;

/** How often picking a stack back up also records this Console as a user, so an
 * idle Console stays inside the register's two-week window without a host write
 * at every launch. */
const SIGHTING_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** When this Console last got a record onto each host, by alias, across launches. */
const sightings = new KV<Record<string, string>>('remote-server-sightings');

/** How long leaving waits to take this Console off a host's register. Leaving
 * is local; the record is a courtesy to the others and not worth a hang. */
const LEAVE_RECORD_TIMEOUT_MS = 20_000;

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
    waitingFor: null,
  };
}

const RECORDED_AS: Record<StackActivityAction, string> = {
  started: 'started it',
  connected: 'connected to it',
  stopped: 'stopped it',
  reset: 'reset it',
  disconnected: 'disconnected from it',
};

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

/** The notice for a stack found not running, or null. `wasRunning` means this
 * Console last saw it up, so it stopped under us and needs explaining. */
function noticeForIdleStack(
  hostLabel: string,
  stack: Exclude<StackOnHost, { kind: 'unreadable' }>,
  wasRunning: boolean,
  removedHere: boolean
): string | null {
  switch (stack.kind) {
    case 'present':
      return wasRunning
        ? `The server on ${hostLabel} was stopped outside this Console — from another Console, or on the host.`
        : null;
    case 'absent':
      if (removedHere) return null;
      return (
        `Nothing is set up on ${hostLabel} any more: the server was removed. Its activity says ` +
        `by whom. Starting it sets up a new, empty one.`
      );
    case 'unshared':
      return unsharedStackMessage(hostLabel, stack.ownerDir);
    case 'incomplete':
      return `The server's settings on ${hostLabel} are missing ${stack.missing.join(', ')}.`;
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
 * A remote stack is shared by everyone with access to its host, so its state is
 * read from the host (at launch, on reconnect, and when it stops answering)
 * rather than remembered.
 */
export class RemoteServerService {
  private readonly statuses = new Map<string, RemoteServerStatus>();
  private readonly hosts = new Map<string, RemoteServerHost>();
  private readonly busy = new Set<string>();
  private readonly startAborts = new Map<string, AbortController>();
  /** The wait for another Console's lock in flight per host, which
   * {@link cancelWait} ends. */
  private readonly lockWaits = new Map<string, AbortController>();
  private initialization: Promise<void> | null = null;
  /** The reconcile, start or connect in flight per host, which {@link ensureReady} waits out. */
  private readonly operations = new Map<string, Promise<void>>();
  /** The start in flight per host, which an automatic upgrade and a Start click share. */
  private readonly starting = new Map<string, Promise<StartRemoteServerResult>>();
  private readonly upgradeListeners = new Set<(serverId: string) => void>();
  /** Hosts {@link ensureReady} has turned something away for since their last
   * upgrade finished, so that it can be told when they are ready. */
  private readonly refused = new Set<string>();
  private readonly lastRecheck = new Map<string, number>();
  /** When this Console last got a record onto each host, as far as this run
   * knows; {@link sightings} carries it across launches. */
  private readonly lastRecorded = new Map<string, number>();
  /** Hosts whose stack this Console reset, until it starts or joins one there
   * again: finding nothing on them is no news to report. */
  private readonly removedHere = new Set<string>();

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

  /** Record this Console, and what it did, on the stack's host. A failed write
   * does not fail the operation it describes; it shows on the server page until
   * a later record succeeds. */
  private async record(
    sshHost: string,
    host: StackStateHost,
    action: StackActivityAction | null
  ): Promise<void> {
    try {
      await writeRecord(host, action);
      this.lastRecorded.set(sshHost, Date.now());
      await sightings.set(sshHost, new Date().toISOString());
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

  private async claimFor(host: RemoteServerHost, action: ServerLockAction): Promise<LockClaim> {
    const identity = await getConsoleIdentity();
    return {
      consoleId: identity.id,
      instance: CONSOLE_INSTANCE,
      name: identity.name,
      hostAccount: await hostAccount(host),
      action,
    };
  }

  /** Take the stack's lock for `action`, waiting for whoever holds it. The wait
   * shows on the status; {@link cancelWait} ends it with {@link ServerLockWaitCancelled}. */
  private async waitForLock(
    sshHost: string,
    host: RemoteServerHost,
    action: ServerLockAction
  ): Promise<ServerLease> {
    const abort = new AbortController();
    this.lockWaits.set(sshHost, abort);
    try {
      return await acquireServerLock(host, await this.claimFor(host, action), {
        mode: 'wait',
        timing: SERVER_LOCK_TIMING,
        signal: abort.signal,
        onWaiting: (holder) =>
          this.setStatus(sshHost, { waitingFor: holder, message: waitingForLockMessage(holder) }),
      });
    } finally {
      this.lockWaits.delete(sshHost);
      if (this.getStatus(sshHost).waitingFor !== null) {
        this.setStatus(sshHost, { waitingFor: null, message: null });
      }
    }
  }

  /** Stop waiting for another Console's lock on `sshHost`. What was waiting —
   * a start, a join, a check — ends having changed nothing. */
  cancelWait(sshHost: string): void {
    this.lockWaits.get(sshHost)?.abort();
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
      const [stack, busy] = await Promise.all([inspectStack(host), this.lockHolder(host)]);
      return probeFromStack(host.label, stack, busy);
    } finally {
      host.dispose();
    }
  }

  /** Who holds the stack's lock, for the setup step to show. Only a hint (whatever
   * it offers takes the lock itself), so a failed read is logged and shown as nobody. */
  private async lockHolder(host: RemoteServerHost): Promise<ServerLockHolder | null> {
    try {
      return await readServerLock(host);
    } catch (error) {
      log.warn(`remote-switch-server: could not read the server lock on ${host.label}`, { error });
      return null;
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

  /** Re-read a running stack that stopped answering, at most once per
   * {@link RECHECK_INTERVAL_MS}. Fire-and-forget; the outcome arrives as a status. */
  recheck(sshHost: string): void {
    this.lookAgain(sshHost, 'running', async (server) => {
      log.info(`remote-switch-server: ${sshHost} stopped answering; reading the host again`);
      await this.reconcileHost(sshHost, server);
    });
  }

  /**
   * Re-read a stack shown as stopped when its page opens: it gets no requests, so
   * nothing else would notice another Console starting or removing it. Reconciled
   * only if it changed, so a still-stopped stack keeps its notice. Rate-limited
   * with {@link recheck}.
   */
  refresh(sshHost: string): void {
    this.lookAgain(sshHost, 'stopped', async (server) => {
      const host = await createRemoteServerHost(sshHost);
      let stack: StackOnHost;
      try {
        stack = await inspectStack(host);
      } finally {
        host.dispose();
      }
      const unchanged = stack.kind === 'unreadable' || (stack.kind === 'present' && !stack.running);
      if (unchanged || this.busy.has(sshHost)) return;
      log.info(`remote-switch-server: ${sshHost} changed while this Console showed it stopped`);
      await this.reconcileHost(sshHost, server);
    });
  }

  /** Run `look` for a host this Console shows in `phase`, at most once per
   * {@link RECHECK_INTERVAL_MS} and never beside another operation on it. */
  private lookAgain(
    sshHost: string,
    phase: 'running' | 'stopped',
    look: (server: { id: string; name: string }) => Promise<void>
  ): void {
    if (this.busy.has(sshHost)) return;
    if (this.getStatus(sshHost).phase !== phase) return;
    if (hostReachabilityService.isBlocked(sshHost)) return;
    const now = Date.now();
    if (now - (this.lastRecheck.get(sshHost) ?? 0) < RECHECK_INTERVAL_MS) return;
    this.lastRecheck.set(sshHost, now);
    void this.track(sshHost, async () => {
      const server = (await this.remoteHosts()).get(sshHost);
      if (!server || this.busy.has(sshHost)) return;
      await look(server);
    }).catch((error: unknown) => {
      log.warn(`remote-switch-server: re-check failed for ${sshHost}`, { error });
    });
  }

  /**
   * Read the host and take its stack up as it is: a running stack is adopted with
   * the host's settings (following its ports if they moved), one not running is
   * shown as stopped. Skipped while the host is blocked — the reachability
   * manager calls back through {@link onHostReachable} when it recovers.
   *
   * Also records how the host's deployed switch-core compares to this build's
   * pin (CHOO-1736). A running stack that is behind, or one whose last upgrade
   * from this account was interrupted, is upgraded instead of adopted; a
   * stopped one that is behind is marked to be upgraded at its next start. The
   * check runs even when the stack is down: its data volumes still hold the
   * schema the last version migrated to, which is what makes a downgrade unsafe.
   */
  private async reconcileHost(
    sshHost: string,
    server: { id: string; name: string }
  ): Promise<void> {
    if (hostReachabilityService.isBlocked(sshHost)) return;
    // Checked here too, with no await before the add: callers check before
    // awaiting the server list, and a Start clicked in that gap must not run beside this.
    if (this.busy.has(sshHost)) return;
    const wasRunning = this.getStatus(sshHost).phase === 'running';
    this.busy.add(sshHost);
    // The live forward stays until the host answers: a failed read says nothing
    // about the stack, and dropping the forward would strand a server still up.
    const live = this.hosts.get(sshHost) ?? null;
    let host: RemoteServerHost | null = null;
    let lease: ServerLease | null = null;
    let kept = false;
    let upgradeNow = false;
    let seenRunning = false;
    try {
      host = await createRemoteServerHost(sshHost);
      // Read only once nobody else is changing the stack: one half-way through
      // someone's start or update would read as stopped, or as behind.
      lease = await this.waitForLock(sshHost, host, 'checking');
      const stack = await inspectStack(host);
      if (stack.kind === 'unreadable') {
        this.leaveUnanswered(sshHost, stack.reason, false);
        return;
      }
      seenRunning = stack.kind !== 'absent' && stack.running;
      // A stopped stack's version is read from this account's `.env`, stale once
      // another account has updated it; refresh it from the published copy, best-effort.
      if (stack.kind === 'present' && !stack.running) {
        await bringWorkingDirInStep(host, stack).catch((error: unknown) => {
          log.warn(
            `remote-switch-server: could not refresh this account's settings on ${sshHost}`,
            {
              error,
            }
          );
        });
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
      // Updating restarts the stack for everyone, so one others used lately waits
      // for someone here to run it. An update this account already started is
      // resumed: the stack is half-migrated.
      const held = upgradeNow && journal === null && (await this.othersUseIt(sshHost, host));
      if (held) upgradeNow = false;
      if (upgradeNow) {
        // The start replaces this Console's forward, if it holds one.
      } else if (stack.kind === 'present' && stack.running) {
        const settings = await adoptRunningStack(host, stack, lease);
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
        // Brought up to date by someone else since this Console turned sessions
        // away for the update: they can run now.
        if (owed === null) this.releaseRefused(sshHost, server.id);
        // Only for a running stack: a stopped one sends nothing, so it
        // cannot be out of step with the user's answer.
        this.setStatus(sshHost, { deployedTelemetry: await readDeployedTelemetry(host) });
        if (Date.now() - (await this.lastSighting(sshHost)) >= SIGHTING_INTERVAL_MS) {
          await this.record(sshHost, host, null);
        }
      } else if (stack.kind !== 'present' && stack.kind !== 'absent' && stack.running && live) {
        // Up and reached through the forward already held, but its settings are
        // unreadable from here: keep what works and say why.
        this.setStatus(sshHost, {
          phase: 'running',
          serverId: server.id,
          notice: noticeForIdleStack(host.label, stack, wasRunning, false),
        });
      } else {
        this.releaseHost(sshHost, live);
        this.setStatus(sshHost, {
          phase: 'stopped',
          serverId: server.id,
          deployedTelemetry: null,
          notice: noticeForIdleStack(host.label, stack, wasRunning, this.removedHere.has(sshHost)),
        });
      }
      this.setStatus(sshHost, {
        ...version,
        upgrade: owed && (held ? { state: 'held', ...owed } : upgradeState(owed, upgradeNow)),
      });
    } catch (error) {
      if (error instanceof ServerLockWaitCancelled) {
        this.setStatus(sshHost, { notice: stoppedWaitingForLockMessage(error.holder) });
        return;
      }
      log.warn(`remote-switch-server: reconcile failed for ${sshHost}`, { error });
      this.leaveUnanswered(
        sshHost,
        error instanceof Error ? error.message : String(error),
        seenRunning
      );
    } finally {
      // Before the host goes: giving the lock back runs over its connection.
      await lease?.release();
      // A host that became the live one owns its forward; any other is throwaway.
      if (!kept) host?.dispose();
      this.busy.delete(sshHost);
    }
    if (!upgradeNow) return;
    try {
      await this.beginStart(sshHost, server.name, false, 'updating');
    } catch (error) {
      // Only the reachability check throws rather than reporting a result.
      log.warn(`remote-switch-server: could not upgrade ${sshHost}`, { error });
      this.failUpgrade(sshHost, error instanceof Error ? error.message : String(error));
    }
  }

  /** Whether other Consoles have used the stack lately, per its register. An
   * unreadable register counts as yes, so an update is asked about, not forced. */
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

  /** The host could not be read, or its stack not taken up. That is not news
   * about the stack, so the phase and forward stay as they were and only the
   * notice says why. `seenRunning`: the stack read as running before the failure. */
  private leaveUnanswered(sshHost: string, reason: string, seenRunning: boolean): void {
    log.warn(`remote-switch-server: could not check the stack on ${sshHost}`, { reason });
    this.setStatus(sshHost, {
      notice: seenRunning
        ? `The server on ${sshHost} is running, but this Console could not connect to it: ${reason}`
        : `Could not check the server on ${sshHost}: ${reason}`,
    });
  }

  /** When this Console last got a record onto `sshHost`: this run's, else the
   * one a previous launch kept. */
  private async lastSighting(sshHost: string): Promise<number> {
    const inRun = this.lastRecorded.get(sshHost);
    if (inRun !== undefined) return inRun;
    const kept = await sightings.get(sshHost);
    const at = kept === null ? Number.NaN : Date.parse(kept);
    return Number.isFinite(at) ? at : 0;
  }

  /** Point the server's record at the ports the stack publishes, if another
   * Console restarted it on different ones. Returns whether they moved. */
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
  start(sshHost: string, serverName: string): Promise<StartRemoteServerResult> {
    return this.track(sshHost, () => this.beginStart(sshHost, serverName, true, 'starting'));
  }

  /** `action` is what the others waiting on the lock are told this Console is
   * doing: an update when it is run to bring the stack up to date. */
  private beginStart(
    sshHost: string,
    serverName: string,
    activate: boolean,
    action: 'starting' | 'updating'
  ): Promise<StartRemoteServerResult> {
    const inFlight = this.starting.get(sshHost);
    if (inFlight) return inFlight;
    const run = this.runStart(sshHost, serverName, activate, action).finally(() => {
      this.starting.delete(sshHost);
    });
    this.starting.set(sshHost, run);
    return run;
  }

  private async runStart(
    sshHost: string,
    serverName: string,
    activate: boolean,
    action: 'starting' | 'updating'
  ): Promise<StartRemoteServerResult> {
    if (this.busy.has(sshHost)) {
      return { kind: 'error', message: `An operation is already in progress for ${sshHost}.` };
    }
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const abort = new AbortController();
    this.startAborts.set(sshHost, abort);
    const before = this.getStatus(sshHost);
    let host: RemoteServerHost | null = null;
    try {
      this.setStatus(sshHost, {
        phase: 'starting',
        error: null,
        notice: null,
        message: `Connecting to ${sshHost}…`,
      });
      host = await createRemoteServerHost(sshHost);
      const lease = await this.waitForLock(sshHost, host, action);
      // Replace any prior live host (and its forward) for this alias — only
      // now that the start goes ahead, so a cancelled wait leaves it as it was.
      this.hosts.get(sshHost)?.dispose();
      this.hosts.delete(sshHost);
      this.setStatus(sshHost, { message: 'Checking Docker…' });
      let result: Awaited<ReturnType<typeof startStack>>;
      try {
        result = await startStack({
          host,
          ref: { kind: 'remote', sshHost },
          serverName,
          activate,
          onMessage: (message) => this.setStatus(sshHost, { message }),
          onLog: (line) => events.emit(remoteServerLogChannel, { sshHost, line }),
          onUpgrade: (owed) => this.setStatus(sshHost, { upgrade: upgradeState(owed, true) }),
          signal: abort.signal,
          checkoutRoot: null,
          lease,
        });
      } finally {
        // Before anything below can dispose of the host it runs over.
        await lease.release();
      }
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
          notice: result.warning,
        });
        this.releaseRefused(sshHost, result.serverId);
        this.removedHere.delete(sshHost);
        await this.record(sshHost, host, 'started');
      }
      reportManagedServerStart('remote', result);
      return result;
    } catch (error) {
      host?.dispose();
      if (error instanceof ServerLockWaitCancelled) {
        this.setStatus(sshHost, {
          phase: before.phase,
          message: null,
          error: before.error,
          notice: before.notice,
        });
        return { kind: 'cancelled' };
      }
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

  /** Tell those {@link ensureReady} turned away for `sshHost` that its stack
   * is at this build's pin now. */
  private releaseRefused(sshHost: string, serverId: string): void {
    if (!this.refused.delete(sshHost)) return;
    for (const listener of this.upgradeListeners) listener(serverId);
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

  /** Join the stack already running on `sshHost` without changing anything on the
   * host (see {@link connectStack}). The host is kept on success: it owns the forward. */
  connect(sshHost: string, serverName: string): Promise<ConnectRemoteServerResult> {
    return this.track(sshHost, async () => {
      const result = await this.runConnect(sshHost, serverName);
      return result.kind === 'behind' ? this.connectByUpdating(sshHost, serverName) : result;
    });
  }

  private async runConnect(
    sshHost: string,
    serverName: string
  ): Promise<ConnectStackResult | { kind: 'cancelled' }> {
    if (this.busy.has(sshHost)) {
      return { kind: 'error', message: `An operation is already in progress for ${sshHost}.` };
    }
    hostReachabilityService.requireReachable(sshHost);
    this.busy.add(sshHost);
    const abort = new AbortController();
    this.startAborts.set(sshHost, abort);
    const before = this.getStatus(sshHost);
    let host: RemoteServerHost | null = null;
    try {
      this.setStatus(sshHost, {
        phase: 'starting',
        error: null,
        notice: null,
        message: `Connecting to ${sshHost}…`,
      });
      host = await createRemoteServerHost(sshHost);
      const lease = await this.waitForLock(sshHost, host, 'connecting');
      this.releaseHost(sshHost, this.hosts.get(sshHost) ?? null);
      let result: ConnectStackResult;
      try {
        result = await connectStack({
          host,
          ref: { kind: 'remote', sshHost },
          serverName,
          onMessage: (message) => this.setStatus(sshHost, { message }),
          signal: abort.signal,
          lease,
        });
      } finally {
        // Joining gives it back as soon as it has read the stack; this is for
        // every way out before that.
        await lease.release();
      }
      if (result.kind === 'connected') {
        this.hosts.set(sshHost, host);
        // Joined only at this build's pin, so nothing is owed any more.
        this.setStatus(sshHost, {
          phase: 'running',
          serverId: result.serverId,
          message: null,
          error: null,
          upgrade: null,
        });
        // Sessions and watchers turned away while an update was owed can run
        // now; the ones waiting out that update carry on by themselves.
        this.releaseRefused(sshHost, result.serverId);
        this.setStatus(sshHost, await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION));
        this.setStatus(sshHost, { deployedTelemetry: await readDeployedTelemetry(host) });
        this.removedHere.delete(sshHost);
        await this.record(sshHost, host, 'connected');
        return result;
      }
      host.dispose();
      if (result.kind === 'behind') {
        // Back to where it was: the update that follows is a start of its own,
        // which takes this as the state to return to if its wait is cancelled.
        this.setStatus(sshHost, {
          phase: before.phase,
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
      if (error instanceof ServerLockWaitCancelled) {
        this.setStatus(sshHost, {
          phase: before.phase,
          message: null,
          error: before.error,
          notice: before.notice,
        });
        return { kind: 'cancelled' };
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`remote-switch-server: connect failed for ${sshHost}`, { error });
      this.setStatus(sshHost, { phase: 'error', message: null, error: message });
      return { kind: 'error', message };
    } finally {
      this.busy.delete(sshHost);
      this.startAborts.delete(sshHost);
    }
  }

  /** Join a stack behind this build's switch-core pin by updating it: a start from
   * the stack's own settings, and so an update for everyone using it. */
  private async connectByUpdating(
    sshHost: string,
    serverName: string
  ): Promise<ConnectRemoteServerResult> {
    const result = await this.beginStart(sshHost, serverName, true, 'updating');
    switch (result.kind) {
      case 'started':
        return {
          kind: 'connected',
          serverId: result.serverId,
          deployedVersion: COMPATIBLE_SWITCH_VERSION,
        };
      case 'docker-unavailable':
      case 'cancelled':
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
   * Stop using the stack on `sshHost` from this Console, leaving it running for
   * everyone else: close the forward, remove the server record (its agents are
   * unlinked and kept) and drop the local credentials.
   */
  async disconnect(sshHost: string): Promise<void> {
    if (this.busy.has(sshHost))
      throw new Error(`An operation is already in progress for ${sshHost}.`);
    this.busy.add(sshHost);
    try {
      // Recorded when the host is reachable: a Console left listed counts as a
      // user for weeks, holding the others' updates. Leaving must not wait on or
      // fail for the host, and a failure is only logged: the page goes with it.
      const live = this.hosts.get(sshHost) ?? null;
      if (!hostReachabilityService.isBlocked(sshHost)) await this.recordLeaving(sshHost, live);
      this.releaseHost(sshHost, live);
      const server = await getRemoteManagedServer(sshHost);
      if (server) await removeServer(server.id);
      await clearSecrets({ secretsKey: remoteSecretsKey(sshHost) });
      await clearPorts({ stateDir: remoteServerStateDir(hostSlug(sshHost)) });
      this.setStatus(sshHost, initialStatus(sshHost));
      this.statuses.delete(sshHost);
      this.lastRecheck.delete(sshHost);
      this.lastRecorded.delete(sshHost);
      this.removedHere.delete(sshHost);
      await sightings.del(sshHost);
    } finally {
      this.busy.delete(sshHost);
    }
  }

  /** Record this Console leaving on `sshHost`'s register, given up after
   * {@link LEAVE_RECORD_TIMEOUT_MS}. Never creates a register where there is none. */
  private async recordLeaving(sshHost: string, live: RemoteServerHost | null): Promise<void> {
    const opened: { host: RemoteServerHost | null; abandoned: boolean } = {
      host: null,
      abandoned: false,
    };
    const record = async () => {
      let host = live;
      if (!host) {
        host = await createRemoteServerHost(sshHost);
        // Opened after leaving gave up on it: nothing else will close it.
        if (opened.abandoned) {
          host.dispose();
          return;
        }
        opened.host = host;
      }
      if (await stateVolumeExists(host)) await writeRecord(host, 'disconnected');
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${LEAVE_RECORD_TIMEOUT_MS / 1000}s`)),
        LEAVE_RECORD_TIMEOUT_MS
      );
    });
    try {
      await Promise.race([record(), timeout]);
    } catch (error) {
      log.warn(`remote-switch-server: could not record disconnected on ${sshHost}`, { error });
    } finally {
      clearTimeout(timer);
      opened.abandoned = true;
      opened.host?.dispose();
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
    let lease: ServerLease | null = null;
    try {
      hostReachabilityService.requireReachable(sshHost);
      host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
      // Refused rather than waited for: stopping a server someone else just
      // started is not what the click asked for.
      lease = await this.lockOrRefuse(sshHost, host, 'stopping');
      this.setStatus(sshHost, { phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host, lease);
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
      if (lease === null && host !== null) {
        // The lock was not had, so nothing was touched: see lockOrRefuse.
        host = null;
        throw error;
      }
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('stop', 'remote', 'failure');
      throw error;
    } finally {
      await lease?.release();
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
    let lease: ServerLease | null = null;
    try {
      hostReachabilityService.requireReachable(sshHost);
      host = this.hosts.get(sshHost) ?? (await createRemoteServerHost(sshHost));
      // Taken before the agents go, and refused rather than waited for, as for
      // a stop: a reset turned away must not have deleted anything first.
      lease = await this.lockOrRefuse(sshHost, host, 'resetting');
      this.setStatus(sshHost, { phase: 'stopping', message: 'Removing agents…' });
      const server = await getRemoteManagedServer(sshHost);
      if (server) await deleteAgentsForServer(server.id);
      this.setStatus(sshHost, { phase: 'stopping', message: 'Destroying containers and data…' });
      await resetStack(host, lease);
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
      this.removedHere.add(sshHost);
      // Kept through the reset on purpose: who destroyed a shared server is
      // exactly what its other users will ask.
      await this.record(sshHost, host, 'reset');
      reportManagedServerOutcome('reset', 'remote', 'success');
    } catch (error) {
      if (lease === null && host !== null) {
        host = null;
        throw error;
      }
      this.setStatus(sshHost, {
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('reset', 'remote', 'failure');
      throw error;
    } finally {
      await lease?.release();
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

  /**
   * Take the lock for a stop or reset, refusing rather than waiting. On failure
   * nothing was touched, so a live forward stays; a host opened just for this is
   * disposed here, and the caller must not release it again.
   */
  private async lockOrRefuse(
    sshHost: string,
    host: RemoteServerHost,
    action: 'stopping' | 'resetting'
  ): Promise<ServerLease> {
    try {
      return await acquireServerLock(host, await this.claimFor(host, action), {
        mode: 'refuse',
        timing: SERVER_LOCK_TIMING,
      });
    } catch (error) {
      if (host !== this.hosts.get(sshHost)) host.dispose();
      throw error;
    }
  }

  /** Abort in-flight health waits and lock waits and drop all forwards (app
   * quit). The remote containers keep running; only the desktop-side tunnels
   * close. */
  dispose(): void {
    for (const abort of this.startAborts.values()) abort.abort();
    this.startAborts.clear();
    for (const abort of this.lockWaits.values()) abort.abort();
    this.lockWaits.clear();
    for (const host of this.hosts.values()) host.dispose();
    this.hosts.clear();
  }
}

export const remoteServerService = new RemoteServerService();
