import { deleteAgentsForServer } from '@main/core/switch-servers/delete-server-agents';
import { getManagedServer } from '@main/core/switch-servers/servers-store';
import {
  reportManagedServerOutcome,
  reportManagedServerStart,
  reportManagedServerStartThrew,
} from '@main/core/telemetry/managed-server';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  CHECKOUT_IMAGE_TAG,
  type CheckoutBuild,
  type DockerAvailability,
  type LocalServerStatus,
  type StartLocalServerResult,
  managedServerUpgradeBlockedReason,
  matrixMigrationFailedMessage,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  localServerLogChannel,
  localServerStatusChannel,
} from '@shared/events/localSwitchServerEvents';
import {
  findCoreCheckout,
  isCheckoutBuildEnabled,
  setCheckoutBuildEnabled,
} from './checkout-build';
import { isStackRunning } from './compose';
import { LOCAL_SERVER_NAME } from './constants';
import { readVersionStatus } from './deployed-version';
import { LocalServerHost } from './host/local-host';
import type { ServerHost } from './host/types';
import {
  owedUpgrade,
  readUpgradeJournal,
  type UpgradeJournal,
  upgradeState,
} from './managed-upgrade';
import { resetStack, startStack, stopStack } from './pipeline';
import { readDeployedTelemetry } from './telemetry-consent';

/**
 * Supervises the managed local Switch stack via the shared {@link startStack}
 * pipeline on a {@link LocalServerHost}. One operation runs at a time (`busy`);
 * every state transition is pushed to the renderer over
 * `localServerStatusChannel`.
 *
 * Deliberately does NOT stop the containers on app quit — the local stack keeps
 * running so its rooms stay live while Switch Console is closed, matching the remote
 * sidecar model. `dispose()` only aborts an in-flight health wait.
 *
 * A stack behind this build's switch-core pin is upgraded on its own at boot
 * (or at its next start, if it is stopped), and {@link ensureReady} holds
 * sessions for its agents until that has finished.
 */
export class LocalServerService {
  private status: LocalServerStatus = {
    phase: 'stopped',
    upgrade: null,
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null,
    error: null,
  };

  private busy = false;
  private startAbort: AbortController | null = null;
  private initialization: Promise<void> | null = null;
  /** The start in flight, which an automatic upgrade and a Start click share. */
  private starting: Promise<StartLocalServerResult> | null = null;
  private readonly upgradeListeners = new Set<(serverId: string) => void>();
  /** Whether {@link ensureReady} has turned anything away since the last
   * upgrade finished, so that it can be told when the server is ready. */
  private refused = false;

  getStatus(): LocalServerStatus {
    return this.status;
  }

  detectDocker(): Promise<DockerAvailability> {
    return new LocalServerHost().detectDocker();
  }

  private setStatus(patch: Partial<LocalServerStatus>): void {
    this.status = { ...this.status, ...patch };
    events.emit(localServerStatusChannel, this.status);
  }

  /**
   * The dev-only checkout-build option for this machine, or null when it is not
   * on offer: a released build, or a dev build that was not launched from a
   * Switch checkout (so there are no Dockerfiles to build from).
   */
  private async readCheckoutBuild(host: ServerHost): Promise<CheckoutBuild | null> {
    if (!import.meta.env.DEV) return null;
    const root = findCoreCheckout();
    if (!root) return null;
    return { root, enabled: await isCheckoutBuildEnabled(host) };
  }

  /** The checkout the next start should build from, or null to pull the pinned
   * released images. */
  private checkoutRootForStart(): string | null {
    const checkout = this.status.checkoutBuild;
    return checkout?.enabled ? checkout.root : null;
  }

  /**
   * Turn building from the local checkout on or off. Dev-only, and only when a
   * checkout was found: anything else is a bug in the caller rather than a
   * state to absorb quietly. Takes effect on the next start — the running
   * containers are whatever the last start built or pulled.
   */
  async setCheckoutBuild(enabled: boolean): Promise<void> {
    const checkout = this.status.checkoutBuild;
    if (!checkout) {
      throw new Error(
        'Building from a local checkout is only available in a dev build launched from a Switch checkout.'
      );
    }
    const host: ServerHost = new LocalServerHost();
    try {
      await setCheckoutBuildEnabled(host, enabled);
      this.setStatus({ checkoutBuild: { ...checkout, enabled } });
    } finally {
      host.dispose();
    }
  }

  /** Reconcile status at boot so a stack that survived the last quit shows as
   * running without the user re-starting it, and so an app update that moved
   * the switch-core pin underneath it is acted on rather than leaving the user
   * on a stale core (CHOO-1736): a running stack that is behind — or one whose
   * last upgrade was interrupted — is upgraded now; a stopped one is marked to
   * be upgraded when it is next started.
   *
   * The drift probe also runs for a stopped stack: its data volumes still hold
   * whatever schema the last version migrated to, which is exactly what makes a
   * downgrade unsafe.
   *
   * Memoised: {@link ensureReady} awaits the same reconcile, then the upgrade
   * it started. */
  initialize(): Promise<void> {
    this.initialization ??= this.reconcile();
    return this.initialization;
  }

  private async reconcile(): Promise<void> {
    const host: ServerHost = new LocalServerHost();
    let upgradeNow = false;
    try {
      this.setStatus({ checkoutBuild: await this.readCheckoutBuild(host) });
      const managed = await getManagedServer();
      if (!managed) return;
      const running = await isStackRunning(host);
      if (running) {
        this.setStatus({ phase: 'running', serverId: managed.id, message: null, error: null });
        // Only for a running stack: a stopped one sends nothing, so it cannot
        // be out of step with the user's answer.
        this.setStatus({ deployedTelemetry: await readDeployedTelemetry(host) });
      }
      const version = await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION);
      // A checkout build is deliberately not a comparable version, so the pin
      // comparison has nothing to say about it — the UI reports it as a
      // checkout build instead of as unexplained drift.
      const drift = version.deployedVersion === CHECKOUT_IMAGE_TAG ? null : version.drift;
      let journal: UpgradeJournal | null;
      try {
        journal = await readUpgradeJournal(host);
      } catch (error) {
        this.setStatus({
          ...version,
          drift,
          upgrade: {
            state: 'failed',
            from: version.deployedVersion ?? 'an unknown version',
            to: COMPATIBLE_SWITCH_VERSION,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const owed = owedUpgrade(drift, journal);
      upgradeNow = owed !== null && (running || journal !== null);
      this.setStatus({ ...version, drift, upgrade: owed && upgradeState(owed, upgradeNow) });
    } catch (error) {
      log.warn('local-switch-server: boot status reconcile failed', { error });
    } finally {
      host.dispose();
    }
    // Not awaited: the boot check is done once the upgrade is under way, and a
    // Start click or a session joins the upgrade through `starting`.
    if (upgradeNow) void this.beginStart(false);
  }

  /**
   * Resolves once sessions may run against this server, waiting out the boot
   * check and any upgrade in flight. Throws when the server still owes an
   * upgrade — stopped, or failed — with the reason to show.
   */
  async ensureReady(serverName: string): Promise<void> {
    await this.initialize();
    while (this.starting) await this.starting;
    const upgrade = this.status.upgrade;
    if (upgrade === null) return;
    if (upgrade.state === 'updating') {
      throw new Error(`${serverName} reports an update in progress, but none is running.`);
    }
    this.refused = true;
    throw new Error(managedServerUpgradeBlockedReason(serverName, upgrade));
  }

  /** Called with the server id when an upgrade finishes that sessions or
   * watchers were turned away for (a failed one retried, or a stopped one
   * started). Those that waited instead carry on by themselves. */
  onUpgradeFinished(listener: (serverId: string) => void): void {
    this.upgradeListeners.add(listener);
  }

  /** Start (or restart) the stack at this build's pin, upgrading it first if
   * it is behind. Joins a start already in flight, such as the boot upgrade. */
  async start(): Promise<StartLocalServerResult> {
    await this.initialize();
    return this.starting ?? this.beginStart(true);
  }

  private beginStart(activate: boolean): Promise<StartLocalServerResult> {
    this.starting ??= this.runStart(activate).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async runStart(activate: boolean): Promise<StartLocalServerResult> {
    if (this.busy) {
      return { kind: 'error', message: 'A local-server operation is already in progress.' };
    }
    this.busy = true;
    this.startAbort = new AbortController();
    const host: ServerHost = new LocalServerHost();
    const checkoutRoot = this.checkoutRootForStart();
    try {
      this.setStatus({ phase: 'starting', error: null, message: 'Checking Docker…' });
      const result = await startStack({
        host,
        ref: { kind: 'local' },
        serverName: LOCAL_SERVER_NAME,
        activate,
        onMessage: (message) => this.setStatus({ message }),
        onLog: (line) => events.emit(localServerLogChannel, { line }),
        onUpgrade: (owed) => this.setStatus({ upgrade: upgradeState(owed, true) }),
        signal: this.startAbort.signal,
        checkoutRoot,
      });
      if (result.kind === 'docker-unavailable') {
        this.setStatus({ phase: 'error', error: result.detail });
        this.failUpgrade(result.detail);
      } else if (result.kind === 'version-downgrade') {
        this.setStatus({
          phase: 'error',
          message: null,
          error: switchVersionDowngradeMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
          drift: { deployed: result.deployed, expected: result.expected, direction: 'downgrade' },
          upgrade: null,
        });
      } else if (result.kind === 'matrix-migration-failed') {
        const error = matrixMigrationFailedMessage(result.deployed, result.expected);
        this.setStatus({ phase: 'error', message: null, error, deployedVersion: result.deployed });
        this.failUpgrade(error);
      } else if (result.kind === 'error') {
        this.setStatus({ phase: 'error', error: result.message });
        this.failUpgrade(result.message);
      } else {
        // The pipeline just wrote this build's pin and converged the containers
        // onto it, so any drift the boot probe found is now resolved.
        this.setStatus({
          phase: 'running',
          serverId: result.serverId,
          message: null,
          error: null,
          deployedVersion: checkoutRoot !== null ? CHECKOUT_IMAGE_TAG : COMPATIBLE_SWITCH_VERSION,
          drift: null,
          upgrade: null,
          deployedTelemetry: { known: true, enabled: result.telemetryEnabled },
        });
        if (this.refused) {
          this.refused = false;
          for (const listener of this.upgradeListeners) listener(result.serverId);
        }
      }
      reportManagedServerStart('local', result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('local-switch-server: start failed', { error });
      this.setStatus({ phase: 'error', error: message });
      this.failUpgrade(message);
      reportManagedServerStartThrew('local');
      return { kind: 'error', message };
    } finally {
      host.dispose();
      this.busy = false;
      this.startAbort = null;
    }
  }

  /** Record why an upgrade did not finish. A start that was not an upgrade
   * has nothing to record here; its error is on the status already. */
  private failUpgrade(error: string): void {
    const upgrade = this.status.upgrade;
    if (!upgrade) return;
    this.setStatus({ upgrade: { state: 'failed', from: upgrade.from, to: upgrade.to, error } });
  }

  async stop(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host);
      const upgrade = this.status.upgrade;
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        upgrade: upgrade && upgradeState(upgrade, false),
      });
      reportManagedServerOutcome('stop', 'local', 'success');
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('stop', 'local', 'failure');
      throw error;
    } finally {
      host.dispose();
      this.busy = false;
    }
  }

  /** Destroy the stack AND its data volumes, and drop the stored secrets so the
   * next start is a clean install. Irreversible — the caller must confirm.
   *
   * The stack's agents are deleted first, here rather than in the caller: the
   * wipe destroys their server-side identity, and an agent that outlives it
   * keeps a dead endpoint and a token for nobody. Doing it behind the reset is
   * what stops a second caller from forgetting. */
  async reset(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'stopping', message: 'Removing agents…' });
      const server = await getManagedServer();
      if (server) await deleteAgentsForServer(server.id);
      this.setStatus({ phase: 'stopping', message: 'Destroying containers and data…' });
      await resetStack(host);
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        deployedVersion: null,
        drift: null,
        upgrade: null,
      });
      reportManagedServerOutcome('reset', 'local', 'success');
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('reset', 'local', 'failure');
      throw error;
    } finally {
      host.dispose();
      this.busy = false;
    }
  }

  dispose(): void {
    this.startAbort?.abort();
    this.startAbort = null;
  }
}

export const localServerService = new LocalServerService();
