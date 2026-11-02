import path from 'node:path';
import { deleteAgentsForServer } from '@main/core/switch-servers/delete-server-agents';
import { getManagedServer } from '@main/core/switch-servers/servers-store';
import {
  reportManagedServerOutcome,
  reportManagedServerStart,
  reportManagedServerStartThrew,
} from '@main/core/telemetry/managed-server';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
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
import { probeHealth } from './health';
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
import { readMattermostEnabled, stopMattermost, writeMattermostEnabled } from './native/mattermost';
import {
  type DockerExport,
  exportDockerStack,
  moveBlockedReason,
} from './native/migrate-from-docker';
import { type NativeLayout, nativeLayout } from './native/native-paths';
import {
  discardNativeData,
  nativeCoreFailureLine,
  type NativeStartOptions,
  type NativeStartResult,
  nativeMattermostLauncher,
  nativeStackRunning,
  nativeStartedAt,
  readNativeDeployedVersion,
  readNativeTelemetry,
  resetNativeStack,
  startNativeStack,
  stopNativeStack,
} from './native/native-stack';
import { localServerBundleRoot, localServerDir } from './paths';
import { resetStack, startStack, stopStack } from './pipeline';
import { readPersistedPorts, rememberPorts } from './ports';
import { readLocalRuntime, writeLocalRuntime } from './runtime';
import { managedSwitchVersion, serverVersionChoice, serverVersionSetting } from './server-version';
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
/** How often a running server is looked at, to notice it stopping on its own. */
const WATCH_INTERVAL_MS = 5_000;
/** Missed probes in a row before something that is still running counts as not
 * answering: one miss is a busy moment, not a verdict. */
const MISSES_ALLOWED = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function initialStatus(): LocalServerStatus {
  return {
    phase: 'stopped',
    runtime: null,
    mattermost: null,
    mattermostState: null,
    notice: null,
    checked: false,
    upgrade: null,
    serverId: null,
    version: managedSwitchVersion(),
    deployedVersion: null,
    drift: null,
    checkoutBuild: null,
    deployedTelemetry: null,
    message: null,
    error: null,
    failedTo: null,
  };
}

export class LocalServerService {
  /** Made on first use rather than at construction, which happens on import:
   * the version it carries is resolved once the launch has validated it. */
  private currentStatus: LocalServerStatus | null = null;

  private get status(): LocalServerStatus {
    this.currentStatus ??= initialStatus();
    return this.currentStatus;
  }

  private set status(status: LocalServerStatus) {
    this.currentStatus = status;
  }

  private busy = false;
  private startAbort: AbortController | null = null;
  private initialization: Promise<void> | null = null;
  /** The start in flight, which an automatic upgrade and a Start click share. */
  private starting: Promise<StartLocalServerResult> | null = null;
  private readonly upgradeListeners = new Set<(serverId: string) => void>();
  /** Whether {@link ensureReady} has turned anything away since the last
   * upgrade finished, so that it can be told when the server is ready. */
  private refused = false;

  /** Watches the running server for it stopping on its own; see {@link watch}. */
  private watchTimer: ReturnType<typeof setInterval> | null = null;
  private watching = false;
  /** Counts phase changes, so a watch that a start, stop or reset overtook
   * while it looked does not report on the server that replaced the one it saw. */
  private phaseChanges = 0;
  /** Probes missed in a row, counted since {@link missesSince} phase changes. */
  private coreMisses = 0;
  /** When the first of those missed probes was sent, for saying how long. */
  private firstMissAt = 0;
  private missesSince = -1;

  getStatus(): LocalServerStatus {
    return this.status;
  }

  detectDocker(): Promise<DockerAvailability> {
    return new LocalServerHost().detectDocker();
  }

  /** Counts starts and stops, so a Mattermost bring-up that a later stop or
   * start overtook does not report into the status of a server it is no longer
   * part of. */
  private mattermostRun = 0;

  /**
   * Bring Mattermost up beside a native server that is already running and in
   * use. Its outcome lands on the status; a failure leaves the server running
   * and says why, rather than failing a start that has already succeeded.
   */
  private async runMattermost(
    bringUp: NonNullable<NativeStartResult['bringUpMattermost']>
  ): Promise<void> {
    const run = this.mattermostRun;
    const current = () => run === this.mattermostRun && this.status.phase === 'running';
    try {
      await bringUp((message) => log.info(`local-switch-server: ${message}`));
      if (current()) this.setStatus({ mattermostState: 'running' });
    } catch (error) {
      log.error('local-switch-server: Mattermost did not start', { error: String(error) });
      if (!current()) return;
      this.setStatus({
        mattermostState: 'failed',
        notice: `The server is running, but Mattermost could not be set up: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    }
  }

  /**
   * Turn Mattermost on or off for a native server: brought up or stopped now
   * when the server is running, and at its next start when it is not.
   */
  async setMattermost(enabled: boolean): Promise<void> {
    if ((await this.runtime()) !== 'native') {
      throw new Error(
        'Mattermost can only be turned on or off for a server that runs without Docker.'
      );
    }
    await writeMattermostEnabled(localServerDir(), enabled);
    this.setStatus({ mattermost: enabled });
    // A running server takes the change now: Mattermost runs on its own and
    // registers itself, so nothing about the server needs restarting.
    if (this.status.phase !== 'running' || this.busy) return;
    const layout = nativeLayout(localServerDir());
    this.mattermostRun++;
    if (!enabled) {
      this.setStatus({ mattermostState: 'off', notice: null });
      await stopMattermost(layout, false);
      return;
    }
    const host: ServerHost = new LocalServerHost();
    try {
      const bringUp = await nativeMattermostLauncher(
        host,
        layout,
        this.checkoutRootForStart(),
        (line) => events.emit(localServerLogChannel, { line })
      );
      this.setStatus({ mattermostState: 'starting', notice: null });
      void this.runMattermost(bringUp);
    } finally {
      host.dispose();
    }
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
    if (patch.phase !== undefined) this.phaseChanges++;
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
    // SWITCH_CONSOLE_SERVER_VERSION overrides the persisted toggle for this
    // run: `checkout` holds it on, a release version holds it off.
    const choice = serverVersionChoice();
    const forcedBy = serverVersionSetting(choice);
    if (choice.kind === 'checkout') return { root: choice.root, enabled: true, forcedBy };
    const root = findCoreCheckout();
    if (!root) return null;
    if (choice.kind === 'release') return { root, enabled: false, forcedBy };
    return { root, enabled: await isCheckoutBuildEnabled(host), forcedBy: null };
  }

  /** The checkout the next start should build from, or null to run the
   * released switch-core. */
  private checkoutRootForStart(): string | null {
    const choice = serverVersionChoice();
    if (choice.kind === 'checkout') return choice.root;
    if (choice.kind === 'release') return null;
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
    if (checkout.forcedBy !== null) {
      throw new Error(
        `Building from this checkout is decided by ${checkout.forcedBy} for this run; ` +
          `unset it and restart Switch Console to use the toggle.`
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
    // Watching starts whatever the boot check found: a first install has no
    // server to find, and the one it is about to start needs watching too.
    this.initialization ??= this.reconcile().finally(() => this.startWatching());
    return this.initialization;
  }

  private async reconcile(): Promise<void> {
    const host: ServerHost = new LocalServerHost();
    let upgradeNow = false;
    let moveNow = false;
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
            managedSwitchVersion(),
            host.label
          )
        : await readVersionStatus(host, managedSwitchVersion());
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
            to: managedSwitchVersion(),
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
      const owed = owedUpgrade(drift, journal);
      upgradeNow = owed !== null && (running || journal !== null);
      // A Docker server that is up moves off Docker now, as an owed upgrade
      // runs now; a stopped one moves when it is next started.
      moveNow = !native && running && !upgradeNow && (await this.canMove(host));
      this.setStatus({ ...version, drift, upgrade: owed && upgradeState(owed, upgradeNow) });
    } catch (error) {
      log.warn('local-switch-server: boot status reconcile failed', { error });
    } finally {
      this.setStatus({ checked: true });
      host.dispose();
    }
    // Not awaited: the boot check is done once the upgrade is under way, and a
    // Start click or a session joins the upgrade through `starting`.
    if (upgradeNow || moveNow) void this.beginStart(false);
  }

  private startWatching(): void {
    if (this.watchTimer !== null) return;
    this.watchTimer = setInterval(() => void this.watch(), WATCH_INTERVAL_MS);
    this.watchTimer.unref?.();
  }

  /**
   * Look at the server once, to notice it stopping without being asked.
   *
   * The phase is otherwise only ever set by this Console's own start, stop and
   * reset, so a switch-core that crashed, was killed or stopped answering would
   * go on showing as running everywhere while nothing it serves can be
   * reached. A server whose process is gone is marked so at once; one whose
   * process is there but whose gateway misses {@link MISSES_ALLOWED} probes in
   * a row is marked as not answering, and back to running if it answers again.
   *
   * Runs on a timer from boot; public so a test can drive it.
   */
  async watch(): Promise<void> {
    if (this.watching || this.busy || this.starting) return;
    const { phase, failedTo } = this.status;
    const lost = phase === 'error' && failedTo === 'run';
    if (phase !== 'running' && !lost) return;
    this.watching = true;
    const seen = this.phaseChanges;
    if (seen !== this.missesSince) {
      this.missesSince = seen;
      this.coreMisses = 0;
    }
    // A start, stop or reset that began while this looked: what it saw is of
    // a server that is being replaced.
    const overtaken = () => seen !== this.phaseChanges || this.busy || this.starting !== null;
    const host: ServerHost = new LocalServerHost();
    try {
      const server = await getManagedServer();
      if (!server) return;
      const native = (await this.runtime()) === 'native';
      const layout = nativeLayout(localServerDir());
      const probedAt = Date.now();
      const answers = await probeHealth(server.url);
      // Null when it could not be told: Docker did not answer.
      let alive: boolean | null;
      if (native) alive = await nativeStackRunning(layout);
      else if (answers) alive = true;
      else {
        alive = await runningImages(host).then(
          (images) => images.has(CORE_SERVICE),
          () => null
        );
      }
      if (overtaken()) return;

      if (lost) {
        if (alive === true && answers) {
          log.info('local-switch-server: the server is answering again');
          this.coreMisses = 0;
          this.setStatus({
            phase: 'running',
            serverId: server.id,
            message: null,
            error: null,
            deployedTelemetry: native
              ? await readNativeTelemetry(layout)
              : await readDeployedTelemetry(host),
          });
        }
        return;
      }

      if (alive === false) {
        // Only a line that says what went wrong: a process that was killed
        // leaves none, and its last ordinary log line would read as a reason.
        const line = native ? await nativeCoreFailureLine(layout) : null;
        const reason = line !== null && /(Error|Exception|FATAL)\b/.test(line) ? line : null;
        if (overtaken()) return;
        const where = native ? ` (full log: ${path.join(layout.logs, 'switch-core.log')})` : '';
        await this.markLost(
          `switch-core stopped unexpectedly${reason ? `: ${reason}` : ''}${where}`
        );
        return;
      }
      if (answers) {
        this.coreMisses = 0;
      } else {
        if (this.coreMisses++ === 0) this.firstMissAt = probedAt;
        if (this.coreMisses < MISSES_ALLOWED) return;
        const seconds = Math.round((Date.now() - this.firstMissAt) / 1000);
        await this.markLost(
          `switch-core stopped answering: its process is still running but has not answered ` +
            `for ${seconds} seconds.`
        );
        return;
      }
    } catch (error) {
      log.warn('local-switch-server: could not check on the server', { error: String(error) });
    } finally {
      host.dispose();
      this.watching = false;
    }
  }

  /** Say the running server has stopped, or stopped answering, on its own. */
  private async markLost(error: string): Promise<void> {
    log.warn(`local-switch-server: ${error}`);
    this.coreMisses = 0;
    this.setStatus({
      phase: 'error',
      failedTo: 'run',
      error,
      message: null,
      notice: null,
      mattermostState: null,
      deployedTelemetry: null,
    });
    await recordLocalActivity('crashed', error);
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

  /**
   * Whether a server that runs on Docker can be moved to the native runtime
   * now, keeping its data. A server that cannot (Docker is down, or the move
   * would get it wrong) stays on Docker and is moved at a later start; why is
   * logged, since nobody asked for the move to see it refused.
   */
  private async canMove(host: ServerHost): Promise<boolean> {
    const docker = await host.detectDocker();
    if (!docker.available) return false;
    const blocked = await moveBlockedReason(host);
    if (blocked !== null) {
      log.info(`local-switch-server: not moving the server off Docker yet: ${blocked}`);
      return false;
    }
    return true;
  }

  private async runStart(activate: boolean): Promise<StartLocalServerResult> {
    if (this.busy) {
      return { kind: 'error', message: 'A local-server operation is already in progress.' };
    }
    this.busy = true;
    this.startAbort = new AbortController();
    const host: ServerHost = new LocalServerHost();
    const checkoutRoot = this.checkoutRootForStart();
    // Read before the phase moves on: whether this start is the way back from
    // a server that stopped, or stopped answering, on its own.
    const recovering = this.status.phase === 'error' && this.status.failedTo === 'run';
    try {
      const runtime = await this.runtime();
      // A server still on Docker moves itself to the native runtime, data and
      // all, at the first start that can; until then it starts on Docker.
      const move = runtime === 'docker' && (await this.canMove(host));
      const native = move || runtime === 'native';
      this.setStatus({
        phase: 'starting',
        error: null,
        notice: null,
        message: move
          ? 'Moving the server off Docker…'
          : native
            ? 'Preparing the server…'
            : 'Checking Docker…',
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
      // A move records the new runtime only once it has worked: until then the
      // Docker server is the one this directory holds.
      if (native && !move) await writeLocalRuntime(localServerDir(), 'native');
      this.mattermostRun++;
      const layout = nativeLayout(localServerDir());
      let bringUpMattermost: NativeStartResult['bringUpMattermost'] = null;
      let result: StartLocalServerResult;
      let moveFailure: string | null = null;
      if (move) {
        const moved = await this.moveOffDocker(host, layout, common);
        if (moved.kind === 'moved') {
          result = moved.result;
          bringUpMattermost = moved.bringUpMattermost;
        } else {
          // The Docker server is as it was; it starts as before, and the move
          // is tried again at a later start.
          moveFailure = moved.reason;
          common.onMessage('Starting the server on Docker…');
          result = await startStack({ ...common, lease: null });
        }
      } else if (native) {
        const started = await startNativeStack({
          ...common,
          layout,
          mattermost: await readMattermostEnabled(localServerDir()),
          bundleRoot: localServerBundleRoot(),
          importFrom: null,
        });
        result = started.result;
        bringUpMattermost = started.bringUpMattermost;
      } else {
        // `compose up` leaves a container that is running alone, however hung
        // it is, so a server that stopped answering is stopped first. The
        // native start and the move off Docker stop everything themselves.
        if (recovering) {
          common.onMessage('Stopping the server that stopped answering…');
          await stopStack(host, null);
        }
        // Nobody else shares the local stack, so there is nothing to lock.
        result = await startStack({ ...common, lease: null });
      }
      // A move that worked leaves a native server; one that failed, the Docker one.
      const ranNative = move ? moveFailure === null : native;
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
          deployedVersion: checkoutRoot !== null ? CHECKOUT_IMAGE_TAG : managedSwitchVersion(),
          drift: null,
          upgrade: null,
          // Read back off the server, not assumed from what was written.
          deployedTelemetry: ranNative
            ? await readNativeTelemetry(layout)
            : await readDeployedTelemetry(host),
          notice:
            moveFailure !== null
              ? `Could not move this server off Docker, so it is still running on Docker: ` +
                `${moveFailure} Its data is safe; Switch Console tries again at the next start.`
              : result.warning,
          mattermostState: bringUpMattermost ? 'starting' : ranNative ? 'off' : null,
        });
        if (bringUpMattermost) void this.runMattermost(bringUpMattermost);
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

  /**
   * Move the Docker server to the native runtime: export its databases, start
   * a native server that imports them, and record the new runtime only once
   * that has worked. Anything short of that undoes the native half and
   * reports why, leaving the Docker stack (whose volumes are never removed)
   * to be started as it was.
   */
  private async moveOffDocker(
    host: ServerHost,
    layout: NativeLayout,
    common: Omit<NativeStartOptions, 'layout' | 'mattermost' | 'bundleRoot' | 'importFrom'>
  ): Promise<
    | {
        kind: 'moved';
        result: StartLocalServerResult;
        bringUpMattermost: NativeStartResult['bringUpMattermost'];
      }
    | { kind: 'failed'; reason: string }
  > {
    common.onMessage('Moving the server off Docker…');
    let exported: DockerExport;
    try {
      exported = await exportDockerStack(host, layout, common.onMessage);
    } catch (error) {
      log.error('local-switch-server: could not export the Docker server', { error });
      return { kind: 'failed', reason: errorMessage(error) };
    }
    try {
      // A Docker server always ran Mattermost; the moved one keeps it.
      await writeMattermostEnabled(localServerDir(), true);
      const started = await startNativeStack({
        ...common,
        layout,
        mattermost: true,
        bundleRoot: localServerBundleRoot(),
        importFrom: exported,
      });
      if (started.result.kind !== 'started') {
        const reason =
          started.result.kind === 'error' ? started.result.message : started.result.kind;
        await this.abandonMove(layout);
        return { kind: 'failed', reason: `${reason} (export kept in ${exported.dir})` };
      }
      await writeLocalRuntime(localServerDir(), 'native');
      this.setStatus({ runtime: 'native' });
      log.info(`local-switch-server: moved the server off Docker; export kept in ${exported.dir}`);
      return { kind: 'moved', ...started };
    } catch (error) {
      log.error('local-switch-server: moving the server off Docker failed', { error });
      await this.abandonMove(layout);
      return { kind: 'failed', reason: `${errorMessage(error)} (export kept in ${exported.dir})` };
    }
  }

  /** Undo the native half of a move that failed. Logged, not thrown: the
   * move's own failure is the one to report. */
  private async abandonMove(layout: NativeLayout): Promise<void> {
    await discardNativeData(layout, localServerBundleRoot()).catch((error: unknown) => {
      log.error('local-switch-server: could not clear the unfinished Docker-free server', {
        error: String(error),
      });
    });
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
      this.mattermostRun++;
      if (native) await stopNativeStack(nativeLayout(localServerDir()), localServerBundleRoot());
      else await stopStack(host, null);
      const upgrade = this.status.upgrade;
      this.setStatus({
        phase: 'stopped',
        message: null,
        error: null,
        deployedTelemetry: null,
        notice: null,
        mattermostState: null,
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
        mattermostState: null,
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
        this.mattermostRun++;
        await resetNativeStack(host, nativeLayout(localServerDir()), localServerBundleRoot());
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
        mattermostState: null,
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
    if (this.watchTimer !== null) clearInterval(this.watchTimer);
    this.watchTimer = null;
  }
}

export const localServerService = new LocalServerService();
