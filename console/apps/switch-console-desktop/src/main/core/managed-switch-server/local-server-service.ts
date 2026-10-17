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
  type LocalActivityEntry,
  type LocalServerRuntime,
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
import { coreStartedAt, isStackRunning, runningImages } from './compose';
import {
  COMPOSE_FILE_NAME,
  CORE_SERVICE,
  ENV_FILE_NAME,
  ENV_STAMP_FILE_NAME,
  LOCAL_SERVER_NAME,
} from './constants';
import { readVersionStatus, versionStatusOf } from './deployed-version';
import { findFreePort, type LocalServerPorts } from './free-port';
import { LocalServerHost } from './host/local-host';
import type { ServerHost } from './host/types';
import { readLocalActivity, recordLocalActivity } from './local-activity';
import {
  type OwedUpgrade,
  owedUpgrade,
  readUpgradeJournal,
  type UpgradeJournal,
  upgradeState,
} from './managed-upgrade';
import { readMattermostEnabled, writeMattermostEnabled } from './native/mattermost';
import { nativeLayout } from './native/native-paths';
import {
  nativeStackRunning,
  nativeStartedAt,
  readNativeDeployedVersion,
  readNativeTelemetry,
  resetNativeStack,
  startNativeStack,
  stopNativeStack,
} from './native/native-stack';
import { localServerDir } from './paths';
import { resetStack, startStack, stopStack } from './pipeline';
import { readPersistedPorts, rememberPorts } from './ports';
import { readLocalRuntime, writeLocalRuntime } from './runtime';
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
    runtime: null,
    mattermost: false,
    notice: null,
    checked: false,
    upgrade: null,
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null,
    error: null,
    failedTo: null,
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

  /**
   * Turn Mattermost on or off for a native server. Takes effect at the next
   * start; a running Mattermost is left alone until then, like any setting a
   * running server read when it started.
   */
  async setMattermost(enabled: boolean): Promise<void> {
    if ((await this.runtime()) !== 'native') {
      throw new Error(
        'Mattermost can only be turned on or off for a server that runs without Docker.'
      );
    }
    await writeMattermostEnabled(localServerDir(), enabled);
    this.setStatus({ mattermost: enabled });
  }

  /** How the server runs, read off its directory and recorded on the status. */
  private async runtime(): Promise<LocalServerRuntime> {
    const runtime = await readLocalRuntime(localServerDir());
    if (this.status.runtime !== runtime) this.setStatus({ runtime });
    return runtime;
  }

  private setStatus(patch: Partial<LocalServerStatus>): void {
    // Any change of phase settles what failed, unless the patch says.
    const failedTo = patch.phase !== undefined ? (patch.failedTo ?? null) : this.status.failedTo;
    this.status = { ...this.status, ...patch, failedTo };
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
      const native = (await this.runtime()) === 'native';
      const layout = nativeLayout(localServerDir());
      if (native) this.setStatus({ mattermost: await readMattermostEnabled(localServerDir()) });
      const managed = await getManagedServer();
      if (!managed) return;
      const running = native ? await nativeStackRunning(layout) : await isStackRunning(host);
      if (running) {
        this.setStatus({ phase: 'running', serverId: managed.id, message: null, error: null });
        // Only for a running stack: a stopped one sends nothing, so it cannot
        // be out of step with the user's answer.
        this.setStatus({
          deployedTelemetry: native
            ? await readNativeTelemetry(layout)
            : await readDeployedTelemetry(host),
        });
      }
      const version = native
        ? versionStatusOf(
            await readNativeDeployedVersion(layout),
            COMPATIBLE_SWITCH_VERSION,
            host.label
          )
        : await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION);
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
      this.setStatus({ checked: true });
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
      const native = (await this.runtime()) === 'native';
      this.setStatus({
        phase: 'starting',
        error: null,
        notice: null,
        message: native ? 'Preparing the server…' : 'Checking Docker…',
      });
      const common = {
        host,
        ref: { kind: 'local' } as const,
        serverName: LOCAL_SERVER_NAME,
        activate,
        onMessage: (message: string) => this.setStatus({ message }),
        onLog: (line: string) => events.emit(localServerLogChannel, { line }),
        onUpgrade: (owed: OwedUpgrade) => this.setStatus({ upgrade: upgradeState(owed, true) }),
        signal: this.startAbort.signal,
        checkoutRoot,
      };
      if (native) await writeLocalRuntime(localServerDir(), 'native');
      const result = native
        ? await startNativeStack({
            ...common,
            layout: nativeLayout(localServerDir()),
            mattermost: await readMattermostEnabled(localServerDir()),
          })
        : // Nobody else shares the local stack, so there is nothing to lock.
          await startStack({ ...common, lease: null });
      if (result.kind === 'docker-unavailable') {
        this.setStatus({ phase: 'error', error: result.detail });
        this.failUpgrade(result.detail);
        await recordLocalActivity('start-failed', result.detail);
      } else if (result.kind === 'version-downgrade') {
        this.setStatus({
          phase: 'error',
          message: null,
          error: switchVersionDowngradeMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
          drift: { deployed: result.deployed, expected: result.expected, direction: 'downgrade' },
          upgrade: null,
        });
        await recordLocalActivity('start-failed', this.status.error);
      } else if (result.kind === 'matrix-migration-failed') {
        const error = matrixMigrationFailedMessage(result.deployed, result.expected);
        this.setStatus({ phase: 'error', message: null, error, deployedVersion: result.deployed });
        this.failUpgrade(error);
        await recordLocalActivity('start-failed', error);
      } else if (result.kind === 'error') {
        this.setStatus({ phase: 'error', error: result.message });
        this.failUpgrade(result.message);
        await recordLocalActivity('start-failed', result.message);
      } else {
        const updatedTo = this.status.upgrade?.to ?? null;
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
          notice: result.warning,
        });
        if (updatedTo !== null) await recordLocalActivity('updated', updatedTo);
        await recordLocalActivity('started', null);
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
      await recordLocalActivity('start-failed', message);
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
    const native = (await this.runtime()) === 'native';
    try {
      this.setStatus({
        phase: 'stopping',
        message: native ? 'Stopping the server…' : 'Stopping containers…',
      });
      if (native) await stopNativeStack(nativeLayout(localServerDir()));
      else await stopStack(host, null);
      const upgrade = this.status.upgrade;
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        notice: null,
        upgrade: upgrade && upgradeState(upgrade, false),
      });
      await recordLocalActivity('stopped', null);
      reportManagedServerOutcome('stop', 'local', 'success');
    } catch (error) {
      reportManagedServerOutcome('stop', 'local', 'failure');
      // A stop that errors may still have stopped the containers. Say what is
      // true rather than what the command reported.
      // Asked so that a failure to ask counts as still running.
      const stillRunning = native
        ? await nativeStackRunning(nativeLayout(localServerDir())).catch(() => true)
        : await runningImages(host).then(
            (images) => images.has(CORE_SERVICE),
            () => true
          );
      if (stillRunning) {
        this.setStatus({
          phase: 'error',
          failedTo: 'stop',
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      log.warn('local-switch-server: stop reported an error, but the stack is down', { error });
      const upgrade = this.status.upgrade;
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        notice: null,
        upgrade: upgrade && upgradeState(upgrade, false),
      });
      await recordLocalActivity('stopped', null);
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
      if ((await this.runtime()) === 'native') {
        this.setStatus({ phase: 'stopping', message: 'Deleting the server and its data…' });
        await resetNativeStack(host, nativeLayout(localServerDir()));
      } else {
        this.setStatus({ phase: 'stopping', message: 'Destroying containers and data…' });
        await resetStack(host, null);
        // Nothing of the Docker stack is left to keep it on Docker, so the next
        // start sets the server up natively.
        for (const file of [COMPOSE_FILE_NAME, ENV_FILE_NAME, ENV_STAMP_FILE_NAME]) {
          await host.removeFile(file);
        }
        await writeLocalRuntime(localServerDir(), 'native');
        this.setStatus({ runtime: 'native' });
      }
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        notice: null,
        deployedVersion: null,
        drift: null,
        upgrade: null,
      });
      await recordLocalActivity('reset', null);
      reportManagedServerOutcome('reset', 'local', 'success');
    } catch (error) {
      this.setStatus({
        phase: 'error',
        failedTo: 'reset',
        error: error instanceof Error ? error.message : String(error),
      });
      reportManagedServerOutcome('reset', 'local', 'failure');
      throw error;
    } finally {
      host.dispose();
      this.busy = false;
    }
  }

  /** When the running stack's core container started, or null when it is not
   * running. */
  async startedAt(): Promise<string | null> {
    if (this.status.phase !== 'running') return null;
    if ((await this.runtime()) === 'native') return nativeStartedAt(nativeLayout(localServerDir()));
    const host: ServerHost = new LocalServerHost();
    try {
      return await coreStartedAt(host);
    } finally {
      host.dispose();
    }
  }

  /** What has happened to the stack, most recent first. */
  activity(): Promise<LocalActivityEntry[]> {
    return readLocalActivity();
  }

  /**
   * Move whichever of the stack's services publishes on `port` to a free port,
   * then start it. For a start that failed because something else took the
   * port since it was chosen.
   */
  async useAnotherPort(port: number): Promise<StartLocalServerResult> {
    if (this.busy || this.starting) {
      throw new Error('A local-server operation is already in progress.');
    }
    const host: ServerHost = new LocalServerHost();
    try {
      const ports = await readPersistedPorts(host);
      if (!ports) throw new Error('This server has not chosen its ports yet.');
      const service = (Object.keys(ports) as (keyof LocalServerPorts)[]).find(
        (key) => ports[key] === port
      );
      if (!service) throw new Error(`This server does not publish anything on port ${port}.`);
      const fresh = await findFreePort(new Set(Object.values(ports)));
      log.info(`local-switch-server: moving ${service} from port ${port} to ${fresh}`);
      await rememberPorts(host, { ...ports, [service]: fresh });
    } finally {
      host.dispose();
    }
    return this.start();
  }

  dispose(): void {
    this.startAbort?.abort();
    this.startAbort = null;
  }
}

export const localServerService = new LocalServerService();
