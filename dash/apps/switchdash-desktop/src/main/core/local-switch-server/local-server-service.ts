import { eq } from 'drizzle-orm';
import { deleteAgent } from '@main/core/agents/deleteAgent';
import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import { passwordLogin } from '@main/core/switch-servers/auth';
import {
  ensureManagedServer,
  getManagedServer,
  setActiveServerId,
} from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { agents } from '@main/db/schema';
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
import { GHCR_REGISTRY, LOCAL_SERVER_ADMIN_EMAIL, LOCAL_SERVER_NAME } from './constants';
import { detectDocker } from './docker';
import { buildEnvFile, writeEnvFile } from './env-file';
import { apiUrlFor, gatewayUrlFor } from './free-port';
import { ensureGhcrLogin } from './ghcr-auth';
import { waitForHealth } from './health';
import { envFilePath } from './paths';
import { clearPorts, resolvePorts } from './ports';
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
   * running without the user re-starting it. The managed server's URLs are the
   * per-machine ones persisted at first start, so we reflect the existing record
   * rather than recomputing — the containers are bound to those ports. */
  async initialize(): Promise<void> {
    try {
      const managed = await getManagedServer();
      if (managed && (await isStackRunning())) {
        this.setStatus({ phase: 'running', serverId: managed.id, message: null, error: null });
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
      // Pick free host ports for this machine (persisted + reused) so the stack
      // never collides with a dev's existing services on 8000 / 5432 / 3000.
      const ports = await resolvePorts();
      const gatewayUrl = gatewayUrlFor(ports);
      const apiUrl = apiUrlFor(ports);
      await writeEnvFile(
        envFilePath(),
        buildEnvFile({
          version: COMPATIBLE_SWITCH_VERSION,
          registry: GHCR_REGISTRY,
          namespace: RELEASE_REPO_OWNER,
          ports,
          secrets,
        })
      );

      this.setStatus({ message: 'Starting containers (pulling images if needed)…' });
      await composeUp((line) => events.emit(localServerLogChannel, { line }));

      this.setStatus({ message: 'Waiting for the server to become healthy…' });
      // Probe via the gateway URL (nginx → switch-core), the same path switchdash's
      // management calls take, so we only register once that whole path answers.
      const healthy = await waitForHealth(gatewayUrl, {
        signal: this.startAbort.signal,
      });
      if (!healthy) {
        const error = 'The local server did not become healthy in time.';
        this.setStatus({ phase: 'error', error });
        return { kind: 'error', message: error };
      }

      const server = await ensureManagedServer({
        name: LOCAL_SERVER_NAME,
        gatewayUrl,
        apiUrl,
      });
      await setActiveServerId(server.id);

      // switchdash generated the admin password, so sign in on the user's behalf
      // rather than showing a login wall for a secret they never saw. A failure
      // here does not fail the start — the stack is healthy; the server view just
      // falls back to its sign-in panel.
      this.setStatus({ message: 'Signing in…' });
      const login = await passwordLogin(
        server,
        LOCAL_SERVER_ADMIN_EMAIL,
        secrets.gatewayAdminPassword
      );
      if (!login.success) {
        log.warn('local-switch-server: auto sign-in failed; server will show a sign-in prompt', {
          error: login.error,
        });
      }

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

  /** Delete the switchdash agents configured against the managed server. Their
   * server-side identity is about to be wiped with the stack, so a bare unlink
   * would leave dangling records; deleteAgent() also tears down each agent's
   * sessions and watchers. Best-effort per agent so one failure can't block the
   * reset. */
  private async deleteManagedAgents(): Promise<void> {
    const managed = await getManagedServer();
    if (!managed) return;
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.serverId, managed.id));
    for (const { id } of rows) {
      try {
        await deleteAgent(id);
      } catch (error) {
        log.warn('local-switch-server: failed to delete agent during reset', { id, error });
      }
    }
    if (rows.length > 0) {
      log.info('local-switch-server: deleted agents on reset', { count: rows.length });
    }
  }

  /** Destroy the stack AND its data volumes, delete every agent configured
   * against it, and drop the stored secrets so the next start is a clean
   * install. Irreversible — the caller must confirm. */
  async reset(): Promise<void> {
    if (this.busy) throw new Error('A local-server operation is already in progress.');
    this.busy = true;
    try {
      this.setStatus({ phase: 'stopping', message: 'Deleting agents and destroying data…' });
      await this.deleteManagedAgents();
      await composeDown(true);
      await clearSecrets();
      await clearPorts();
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
