import { deleteAgentsForServer } from '@main/core/switch-servers/delete-server-agents';
import { getManagedServer } from '@main/core/switch-servers/servers-store';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION } from '@shared/app-identity';
import {
  type DockerAvailability,
  type LocalServerStatus,
  type StartLocalServerResult,
  switchVersionDowngradeMessage,
} from '@shared/core/managed-switch-server/managed-switch-server';
import {
  localServerLogChannel,
  localServerStatusChannel,
} from '@shared/events/localSwitchServerEvents';
import { isStackRunning } from './compose';
import { LOCAL_SERVER_NAME } from './constants';
import { readVersionStatus } from './deployed-version';
import { LocalServerHost } from './host/local-host';
import type { ServerHost } from './host/types';
import { resetStack, startStack, stopStack } from './pipeline';

/**
 * Supervises the managed local Switch stack via the shared {@link startStack}
 * pipeline on a {@link LocalServerHost}. One operation runs at a time (`busy`);
 * every state transition is pushed to the renderer over
 * `localServerStatusChannel`.
 *
 * Deliberately does NOT stop the containers on app quit — the local stack keeps
 * running so its rooms stay live while switchdash is closed, matching the remote
 * sidecar model. `dispose()` only aborts an in-flight health wait.
 */
class LocalServerService {
  private status: LocalServerStatus = {
    phase: 'stopped',
    serverId: null,
    version: COMPATIBLE_SWITCH_VERSION,
    deployedVersion: null,
    drift: null,
    message: null,
    error: null,
  };

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

  /** Reconcile status at boot so a stack that survived the last quit shows as
   * running without the user re-starting it, and so an app update that moved
   * the switch-core pin underneath it surfaces as drift instead of leaving the
   * user on a stale core indefinitely (CHOO-1736).
   *
   * The drift probe also runs for a stopped stack: its data volumes still hold
   * whatever schema the last version migrated to, which is exactly what makes a
   * downgrade unsafe. */
  async initialize(): Promise<void> {
    const host: ServerHost = new LocalServerHost();
    try {
      const managed = await getManagedServer();
      if (!managed) return;
      if (await isStackRunning(host)) {
        this.setStatus({ phase: 'running', serverId: managed.id, message: null, error: null });
      }
      this.setStatus(await readVersionStatus(host, COMPATIBLE_SWITCH_VERSION));
    } catch (error) {
      log.warn('local-switch-server: boot status reconcile failed', { error });
    } finally {
      host.dispose();
    }
  }

  async start(): Promise<StartLocalServerResult> {
    if (this.busy) {
      return { kind: 'error', message: 'A local-server operation is already in progress.' };
    }
    this.busy = true;
    this.startAbort = new AbortController();
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'starting', error: null, message: 'Checking Docker…' });
      const result = await startStack({
        host,
        ref: { kind: 'local' },
        serverName: LOCAL_SERVER_NAME,
        onMessage: (message) => this.setStatus({ message }),
        onLog: (line) => events.emit(localServerLogChannel, { line }),
        signal: this.startAbort.signal,
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
      } else if (result.kind === 'error') {
        this.setStatus({ phase: 'error', error: result.message });
      } else {
        // The pipeline just wrote this build's pin and converged the containers
        // onto it, so any drift the boot probe found is now resolved.
        this.setStatus({
          phase: 'running',
          serverId: result.serverId,
          message: null,
          error: null,
          deployedVersion: COMPATIBLE_SWITCH_VERSION,
          drift: null,
        });
      }
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('local-switch-server: start failed', { error });
      this.setStatus({ phase: 'error', error: message });
      return { kind: 'error', message };
    } finally {
      host.dispose();
      this.busy = false;
      this.startAbort = null;
    }
  }

  async stop(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    const host: ServerHost = new LocalServerHost();
    try {
      this.setStatus({ phase: 'stopping', message: 'Stopping containers…' });
      await stopStack(host);
      this.setStatus({ phase: 'stopped', message: null, error: null });
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
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
      this.setStatus({ phase: 'stopped', message: null, error: null });
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
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
