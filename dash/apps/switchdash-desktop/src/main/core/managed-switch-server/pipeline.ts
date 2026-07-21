import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import { passwordLogin } from '@main/core/switch-servers/auth';
import { ensureManagedServer, setActiveServerId } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION, RELEASE_REPO_OWNER } from '@shared/app-identity';
import type { StartLocalServerResult } from '@shared/core/managed-switch-server/managed-switch-server';
import type { ManagedServerRef } from '@shared/core/switch-servers/switch-servers';
import { bundledComposeYaml } from './bundled-compose';
import { composeDown, composeUp } from './compose';
import {
  COMPOSE_FILE_NAME,
  ENV_FILE_NAME,
  GHCR_REGISTRY,
  LOCAL_SERVER_ADMIN_EMAIL,
} from './constants';
import { buildEnvFile } from './env-file';
import { apiUrlFor, gatewayUrlFor } from './free-port';
import { waitForHealth } from './health';
import type { ServerHost } from './host/types';
import { clearPorts, resolvePorts } from './ports';
import { clearSecrets, loadOrCreateSecrets } from './secrets';

/**
 * The transport-agnostic lifecycle for a switchdash-managed Switch stack, run
 * against a {@link ServerHost}. Shared by the local-server service (a single
 * local host) and the remote-server service (one host per SSH alias); each wraps
 * these with its own phase/status bookkeeping.
 */

export type StartStackOptions = {
  host: ServerHost;
  /** Which managed record to upsert (local, or a specific remote host). */
  ref: ManagedServerRef;
  /** Display name for the registered server record. */
  serverName: string;
  /** Coarse step messages for the UI ("Pulling images…"). */
  onMessage: (message: string) => void;
  /** Live compose output lines for the UI log tail. */
  onLog: (line: string) => void;
  /** Aborts an in-flight health wait (stop/cancel/quit). */
  signal: AbortSignal;
};

/**
 * Full start pipeline: detect Docker → GHCR login → materialise compose + `.env`
 * → `compose up` → establish networking → health-gate → register + activate →
 * silent admin sign-in → reconcile agent servers. Returns without registering
 * anything if Docker is unavailable or the stack never turns healthy.
 */
export async function startStack(opts: StartStackOptions): Promise<StartLocalServerResult> {
  const { host, ref, serverName, onMessage, onLog, signal } = opts;

  const docker = await host.detectDocker();
  if (!docker.available) {
    return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
  }

  onMessage('Authenticating to image registry…');
  await host.ensureGhcrLogin();

  onMessage('Preparing configuration…');
  await host.writeFile(COMPOSE_FILE_NAME, bundledComposeYaml());
  const secrets = await loadOrCreateSecrets(host);
  const ports = await resolvePorts(host);
  const gatewayUrl = gatewayUrlFor(ports);
  const apiUrl = apiUrlFor(ports);
  await host.writeFile(
    ENV_FILE_NAME,
    buildEnvFile({
      version: COMPATIBLE_SWITCH_VERSION,
      registry: GHCR_REGISTRY,
      namespace: RELEASE_REPO_OWNER,
      ports,
      secrets,
    }),
    0o600
  );

  onMessage('Starting containers (pulling images if needed)…');
  await composeUp(host, onLog);

  // Make the published ports reachable from the desktop (no-op locally; a
  // mirrored SSH forward remotely) BEFORE the health probe, so the probe takes
  // the same path clients will.
  await host.establishNetworking(ports);

  onMessage('Waiting for the server to become healthy…');
  const healthy = await waitForHealth(gatewayUrl, { signal });
  if (!healthy) {
    return { kind: 'error', message: 'The server did not become healthy in time.' };
  }

  const server = await ensureManagedServer({ name: serverName, gatewayUrl, apiUrl }, ref);
  await setActiveServerId(server.id);

  // switchdash generated the admin password, so sign in on the user's behalf
  // rather than showing a login wall for a secret they never saw. A failure here
  // does not fail the start — the stack is healthy; the server view falls back
  // to its sign-in panel.
  onMessage('Signing in…');
  const login = await passwordLogin(server, LOCAL_SERVER_ADMIN_EMAIL, secrets.gatewayAdminPassword);
  if (!login.success) {
    log.warn('managed-switch-server: auto sign-in failed; server will show a sign-in prompt', {
      error: login.error,
    });
  }

  await resolveAgentServers();
  return { kind: 'started', serverId: server.id };
}

/** Stop the stack's containers and tear down networking (leaves data + config). */
export async function stopStack(host: ServerHost): Promise<void> {
  await composeDown(host, false);
  await host.teardownNetworking();
}

/** Destroy the stack, its data volumes, stored secrets, and port choice — the
 * irreversible clean-slate reset. */
export async function resetStack(host: ServerHost): Promise<void> {
  await composeDown(host, true);
  await host.teardownNetworking();
  await clearSecrets(host);
  await clearPorts(host);
}
