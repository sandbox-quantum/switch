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
import { prepareLocalUpgrade, finishLocalUpgrade, hasPendingLocalUpgrade } from './local-upgrade';
import { resetStack, startStack, stopStack } from './pipeline';
import { verifySdkCompatibility } from './sdk-compatibility';

/**
 * Supervises the managed local Switch stack via the shared {@link startStack}
 * pipeline on a {@link LocalServerHost}. One operation runs at a time (`busy`);
 * every state transition is pushed to the renderer over
 * `localServerStatusChannel`.
 *
 * Deliberately does NOT stop the containers on app quit — the local stack keeps
 * running so its rooms stay live while Switch Console is closed, matching the remote
 * sidecar model. `dispose()` only aborts an in-flight health wait.
 */
export class LocalServerService {
  private status: LocalServerStatus = {
    phase: 'stopped',
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    checkoutBuild: null,
    message: null,
    error: null,
  };

  private initialization: Promise<void> | null = null;
  private starting: Promise<StartLocalServerResult> | null = null;
  private readonly readyListeners = new Set<(serverId: string) => void>();

  onReady(listener: (serverId: string) => void): void {
    this.readyListeners.add(listener);
  }

  private busy = false;
  private startAbort: AbortController | null = null;

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

  initialize(): Promise<void> {
    this.initialization ??= this.reconcile();
    return this.initialization;
  }

  async ensureReady(): Promise<void> {
    await this.initialize();
    if (this.starting) await this.starting;
    if (this.status.phase !== 'running' || this.status.upgrade) {
      throw new Error(
        this.status.error ??
          (this.status.upgrade
            ? 'Your local Switch server needs an update. Open the server page to finish updating.'
            : 'Start your local Switch server from the server page, then retry.')
      );
    }
  }

  private async reconcile(): Promise<void> {
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ checkoutBuild: await this.readCheckoutBuild(host) });
      const managed = await getManagedServer();
      if (!managed) return;
      this.setStatus({
        serverId: managed.id,
        upgrade: 'checking',
        message: 'Checking your local server…',
      });
      const version = await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION);
      const checkout =
        version.deployedVersion === CHECKOUT_IMAGE_TAG && this.status.checkoutBuild?.enabled;
      this.setStatus(checkout ? { ...version, drift: null } : version);
      const running = await isStackRunning(host);
      const pending = await hasPendingLocalUpgrade(host);
      if (!running && !pending) {
        this.setStatus({
          phase: 'stopped',
          upgrade: version.drift ? 'required' : null,
          message: null,
        });
        return;
      }
      if (!checkout && (version.drift?.direction === 'upgrade' || pending)) {
        await this.beginStart(false);
        return;
      }
      if (!checkout && version.drift) {
        throw new Error(
          version.drift.direction === 'downgrade'
            ? switchVersionDowngradeMessage(version.drift.deployed, version.drift.expected)
            : 'Could not verify the installed server version. Check Docker and retry from the server page.'
        );
      }
      // Gateway sign-in is allowed while starting; sessions remain gated.
      this.setStatus({ phase: 'starting' });
      await verifySdkCompatibility(managed);
      this.setStatus({ phase: 'running', upgrade: null, message: null, error: null });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.warn('local-switch-server: boot readiness check failed', { error });
      this.setStatus({ phase: 'error', upgrade: 'required', message: null, error: message });
    } finally {
      host.dispose();
    }
  }

  async start(): Promise<StartLocalServerResult> {
    const wasRunning = this.status.phase === 'running';
    await this.initialize();
    if (!wasRunning && this.status.phase === 'running' && this.status.serverId) {
      return { kind: 'started', serverId: this.status.serverId };
    }
    return this.beginStart(true);
  }

  private beginStart(activate: boolean): Promise<StartLocalServerResult> {
    if (this.starting) return this.starting;
    this.starting = this.runStart(activate).finally(() => {
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
      this.setStatus({
        phase: 'starting',
        error: null,
        message: 'Checking Docker…',
        upgrade: 'updating',
      });
      const docker = await host.detectDocker();
      if (!docker.available) {
        const detail =
          docker.reason === 'daemon-down'
            ? 'Open Docker, then retry to finish updating your local server.'
            : 'Install Docker, then retry to start your local server.';
        this.setStatus({ phase: 'error', upgrade: 'required', message: null, error: detail });
        const result = { kind: 'docker-unavailable' as const, reason: docker.reason, detail };
        reportManagedServerStart('local', result);
        return result;
      }
      await prepareLocalUpgrade(host, checkoutRoot, (message) => this.setStatus({ message }));
      const result = await startStack({
        host,
        ref: { kind: 'local' },
        serverName: LOCAL_SERVER_NAME,
        activate,
        onMessage: (message) => this.setStatus({ message }),
        onLog: (line) => events.emit(localServerLogChannel, { line }),
        signal: this.startAbort.signal,
        checkoutRoot,
      });
      if (result.kind === 'docker-unavailable') {
        this.setStatus({ phase: 'error', error: result.detail });
      } else if (result.kind === 'version-downgrade') {
        this.setStatus({
          phase: 'error',
          message: null,
          error: switchVersionDowngradeMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
          drift: { deployed: result.deployed, expected: result.expected, direction: 'downgrade' },
        });
      } else if (result.kind === 'matrix-migration-failed') {
        this.setStatus({
          phase: 'error',
          message: null,
          error: matrixMigrationFailedMessage(result.deployed, result.expected),
          deployedVersion: result.deployed,
        });
      } else if (result.kind === 'error') {
        this.setStatus({ phase: 'error', error: result.message });
      } else {
        this.setStatus({ message: 'Checking session compatibility…' });
        const managed = await getManagedServer();
        if (!managed)
          throw new Error('The local server registration is missing. Retry the update.');
        await verifySdkCompatibility(managed);
        await finishLocalUpgrade(host);
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
        });
      }
      if (result.kind !== 'started') this.setStatus({ upgrade: 'required', message: null });
      if (result.kind === 'started')
        for (const listener of this.readyListeners) listener(result.serverId);
      reportManagedServerStart('local', result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('local-switch-server: start failed', { error });
      this.setStatus({ phase: 'error', upgrade: 'required', message: null, error: message });
      reportManagedServerStartThrew('local');
      return { kind: 'error', message };
    } finally {
      host.dispose();
      this.busy = false;
      this.startAbort = null;
    }
  }

  async stop(): Promise<void> {
    await this.initialize();
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host);
      this.setStatus({ phase: 'stopped', upgrade: null, message: null, error: null });
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
    await this.initialize();
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'stopping', message: 'Removing agents…' });
      const server = await getManagedServer();
      if (server) await deleteAgentsForServer(server.id);
      this.setStatus({ phase: 'stopping', message: 'Destroying containers and data…' });
      await resetStack(host);
      await finishLocalUpgrade(host);
      this.setStatus({ phase: 'stopped', upgrade: null, message: null, error: null });
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
    this.readyListeners.clear();
    this.startAbort?.abort();
    this.startAbort = null;
  }
}

export const localServerService = new LocalServerService();
