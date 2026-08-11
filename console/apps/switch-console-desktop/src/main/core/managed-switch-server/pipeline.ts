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
import { classifyVersionDrift, readDeployedVersion } from './deployed-version';
import { buildEnvFile } from './env-file';
import { apiUrlFor, gatewayUrlFor } from './free-port';
import { waitForHealth } from './health';
import type { ServerHost } from './host/types';
import { clearPorts, resolvePorts } from './ports';
import { clearSecrets, loadOrCreateSecrets } from './secrets';

/**
 * The transport-agnostic lifecycle for a Switch Console-managed Switch stack, run
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
 * Refuse to point an existing stack at an OLDER switch-core than it already
 * runs. switch-core migrates its database forward at startup and Alembic has no
 * downgrade path, so rolling Switch Console back would hand an old core a schema it
 * cannot read — silent, and only discovered once the data is already stuck.
 *
 * Runs before anything is written: the `.env` still names the version the stack
 * was last started with, so a refused start leaves the host exactly as it was
 * and re-installing the newer Switch Console is enough to recover.
 *
 * This blocks the PROVABLE downgrade only. Two cases pass through, and both are
 * now said out loud rather than passing in silence (CHOO-1865):
 *
 * - The deployed version cannot be read. A transient daemon or SSH failure must
 *   not make the app unstartable.
 * - The two versions are not comparable — a dev tag, a fork's tag, anything that
 *   is not semver. `classifyVersionDrift` reports `unknown`, which used to fall
 *   into the same "not a downgrade" branch as a clean match and vanish. It
 *   carries the same risk as a downgrade; we simply cannot prove it.
 *
 * So this is a guard against the known-bad case, not a proof of safety, and the
 * log has to make that difference visible to whoever reads it afterwards.
 */
async function refuseDowngrade(
  host: ServerHost
): Promise<{ kind: 'version-downgrade'; deployed: string; expected: string } | null> {
  const deployed = await readDeployedVersion(host);
  if (deployed.kind === 'absent') return null;
  if (deployed.kind === 'unreadable') {
    log.warn(`managed-switch-server: starting ${host.label} without a deployed-version check`, {
      reason: deployed.reason,
    });
    return null;
  }
  const drift = classifyVersionDrift(deployed.version, COMPATIBLE_SWITCH_VERSION);
  if (drift?.direction === 'unknown') {
    log.error(
      `managed-switch-server: starting ${host.label} without proving it is not a downgrade — ` +
        `deployed switch-core ${deployed.version} and pinned ${COMPATIBLE_SWITCH_VERSION} are not comparable. ` +
        `If the deployed one is in fact newer, its database has already migrated and this start may strand it.`
    );
    return null;
  }
  if (drift?.direction !== 'downgrade' || drift.deployed === null) return null;
  log.error(
    `managed-switch-server: refusing to downgrade ${host.label} from switch-core ${drift.deployed} to ${drift.expected}`
  );
  return { kind: 'version-downgrade', deployed: drift.deployed, expected: drift.expected };
}

/**
 * Full start pipeline: detect Docker → refuse a downgrade → GHCR login →
 * materialise compose + `.env` → `compose up` → establish networking →
 * health-gate → register + activate → silent admin sign-in → reconcile agent
 * servers. Returns without registering anything if Docker is unavailable, the
 * stack is newer than this build, or it never turns healthy.
 *
 * Doubles as the update path: the `.env` and compose file are re-materialised
 * from this build every time, so `compose up -d` on an already-running stack
 * re-pulls the newly pinned tags and recreates only the changed containers,
 * leaving the data volumes in place for switch-core to migrate forward.
 */
export async function startStack(opts: StartStackOptions): Promise<StartLocalServerResult> {
  const { host, ref, serverName, onMessage, onLog, signal } = opts;

  const docker = await host.detectDocker();
  if (!docker.available) {
    return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
  }

  onMessage('Checking the deployed version…');
  const downgrade = await refuseDowngrade(host);
  if (downgrade) return downgrade;

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

  // Switch Console generated the admin password, so sign in on the user's behalf
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
