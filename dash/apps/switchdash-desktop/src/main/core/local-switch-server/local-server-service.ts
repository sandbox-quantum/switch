import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import {
  ensureManagedServer,
  getManagedServer,
  setActiveServerId,
} from '@main/core/switch-servers/servers-store';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION, RELEASE_REPO_OWNER } from '@shared/app-identity';
import type {
  DockerAvailability,
  LocalServerStatus,
  StartLocalServerResult,
} from '@shared/core/local-switch-server/local-switch-server';
import {
  localServerLogChannel,
  localServerStatusChannel,
} from '@shared/events/localSwitchServerEvents';
import { materialiseComposeFile } from './bundled-compose';
import { composeDown, composeUp, isStackRunning } from './compose';
import {
  GHCR_REGISTRY,
  LOCAL_SERVER_API_URL,
  LOCAL_SERVER_GATEWAY_URL,
  LOCAL_SERVER_NAME,
} from './constants';
import { detectDocker } from './docker';
import { buildEnvFile, writeEnvFile } from './env-file';
import { ensureGhcrLogin } from './ghcr-auth';
import { waitForHealth } from './health';
import { envFilePath } from './paths';
import { clearSecrets, loadOrCreateSecrets } from './secrets';

/**
 * Supervises the managed local Switch stack: Docker detection, config
 * generation, `docker compose` lifecycle, health-gated registration, and
 * stop/reset. One operation runs at a time (`busy`); every state transition is
 * pushed to the renderer over `localServerStatusChannel`.
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
    message: null,
    error: null,
  };

  private busy = false;
  private startAbort: AbortController | null = null;

  getStatus(): LocalServerStatus {
    return this.status;
  }

  detectDocker(): Promise<DockerAvailability> {
    return detectDocker();
  }

  private setStatus(patch: Partial<LocalServerStatus>): void {
    this.status = { ...this.status, ...patch };
    events.emit(localServerStatusChannel, this.status);
  }

  /** Reconcile status at boot so a stack that survived the last quit shows as
   * running without the user re-starting it. A surviving stack never goes
   * through start(), so migrate the managed row to the current URL contract here
   * too — the compose ports/gateway can change across app versions. */
  async initialize(): Promise<void> {
    try {
      const managed = await getManagedServer();
      if (managed && (await isStackRunning())) {
        const server = await ensureManagedServer({
          name: LOCAL_SERVER_NAME,
          gatewayUrl: LOCAL_SERVER_GATEWAY_URL,
          apiUrl: LOCAL_SERVER_API_URL,
        });
        this.setStatus({ phase: 'running', serverId: server.id, message: null, error: null });
      }
    } catch (error) {
      log.warn('local-switch-server: boot status reconcile failed', { error });
    }
  }

  async start(): Promise<StartLocalServerResult> {
    if (this.busy) {
      return { kind: 'error', message: 'A local-server operation is already in progress.' };
    }
    this.busy = true;
    this.startAbort = new AbortController();
    try {
      this.setStatus({ phase: 'starting', error: null, message: 'Checking Docker…' });
      const docker = await detectDocker();
      if (!docker.available) {
        this.setStatus({ phase: 'error', error: docker.detail });
        return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
      }

      this.setStatus({ message: 'Authenticating to image registry…' });
      await ensureGhcrLogin();

      this.setStatus({ message: 'Preparing configuration…' });
      await materialiseComposeFile();
      const secrets = await loadOrCreateSecrets();
      await writeEnvFile(
        envFilePath(),
        buildEnvFile({
          version: COMPATIBLE_SWITCH_VERSION,
          registry: GHCR_REGISTRY,
          namespace: RELEASE_REPO_OWNER,
          secrets,
        })
      );

      this.setStatus({ message: 'Starting containers (pulling images if needed)…' });
      await composeUp((line) => events.emit(localServerLogChannel, { line }));

      this.setStatus({ message: 'Waiting for the server to become healthy…' });
      // Probe via the gateway URL (nginx → switch-core), the same path switchdash's
      // management calls take, so we only register once that whole path answers.
      const healthy = await waitForHealth(LOCAL_SERVER_GATEWAY_URL, {
        signal: this.startAbort.signal,
      });
      if (!healthy) {
        const error = 'The local server did not become healthy in time.';
        this.setStatus({ phase: 'error', error });
        return { kind: 'error', message: error };
      }

      const server = await ensureManagedServer({
        name: LOCAL_SERVER_NAME,
        gatewayUrl: LOCAL_SERVER_GATEWAY_URL,
        apiUrl: LOCAL_SERVER_API_URL,
      });
      await setActiveServerId(server.id);
      await resolveAgentServers();

      this.setStatus({ phase: 'running', serverId: server.id, message: null, error: null });
      return { kind: 'started', serverId: server.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error('local-switch-server: start failed', { error });
      this.setStatus({ phase: 'error', error: message });
      return { kind: 'error', message };
    } finally {
      this.busy = false;
      this.startAbort = null;
    }
  }

  async stop(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    try {
      this.setStatus({ phase: 'stopping', message: 'Stopping containers…' });
      await composeDown(false);
      this.setStatus({ phase: 'stopped', message: null, error: null });
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  /** Destroy the stack AND its data volumes, then drop the stored secrets so the
   * next start is a clean install. Irreversible — the caller must confirm. */
  async reset(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    try {
      this.setStatus({ phase: 'stopping', message: 'Destroying containers and data…' });
      await composeDown(true);
      await clearSecrets();
      this.setStatus({ phase: 'stopped', message: null, error: null });
    } catch (error) {
      this.setStatus({
        phase: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.busy = false;
    }
  }

  dispose(): void {
    this.startAbort?.abort();
    this.startAbort = null;
  }
}

export const localServerService = new LocalServerService();
