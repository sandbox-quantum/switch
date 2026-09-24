import { resolveAgentServers } from '@main/core/agents/resolve-servers';
import { passwordLogin } from '@main/core/switch-servers/auth';
import { ensureManagedServer, setActiveServerId } from '@main/core/switch-servers/servers-store';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION, RELEASE_REPO_OWNER } from '@shared/app-identity';
import {
  CHECKOUT_IMAGE_TAG,
  type ConnectRemoteServerResult,
  type StartLocalServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { ManagedServerRef } from '@shared/core/switch-servers/switch-servers';
import { bundledComposeYaml } from './bundled-compose';
import { checkoutBuildOverrideYaml } from './checkout-build';
import { composeDown, composeUp } from './compose';
import {
  BUILD_OVERRIDE_FILE_NAME,
  COMPOSE_FILE_NAME,
  ENV_FILE_NAME,
  GHCR_REGISTRY,
  LOCAL_SERVER_ADMIN_EMAIL,
} from './constants';
import { classifyVersionDrift, readDeployedVersion } from './deployed-version';
import { buildEnvFile, keysDisagreeing } from './env-file';
import { apiUrlFor, gatewayUrlFor, type LocalServerPorts } from './free-port';
import { waitForHealth } from './health';
import type { ServerHost } from './host/types';
import { crossesMatrixBoundary, runBackfill } from './matrix-migration';
import { clearPorts, readPersistedPorts, rememberPorts, resolvePorts } from './ports';
import { type LocalServerSecrets, withRuntimePassword } from './secret-values';
import { clearSecrets, loadOrCreateSecrets, readSecrets, storeSecrets } from './secrets';
import {
  inspectStack,
  publishEnv,
  type StackOnHost,
  unsharedStackMessage,
  withdrawPublishedEnv,
} from './stack-state';
import { telemetryConsent } from './telemetry-consent';

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
  /** Dev-only: root of the Switch checkout to build the stack's images from,
   * instead of pulling this build's pinned images. Null is the released path. */
  checkoutRoot: string | null;
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
  host: ServerHost,
  checkoutRoot: string | null
): Promise<{ kind: 'version-downgrade'; deployed: string; expected: string } | null> {
  const deployed = await readDeployedVersion(host);
  if (deployed.kind === 'absent') return null;
  if (checkoutRoot !== null) {
    log.warn(
      `managed-switch-server: starting ${host.label} from the checkout at ${checkoutRoot} — ` +
        `the downgrade check is skipped, because a working tree carries no comparable version. ` +
        `If the stack's database is ahead of that checkout, this start may strand it.`
    );
    return null;
  }
  if (deployed.kind === 'deployed' && deployed.version === CHECKOUT_IMAGE_TAG) {
    log.warn(
      `managed-switch-server: ${host.label} currently runs a local checkout build, so the ` +
        `downgrade check cannot run; pointing it back at pinned switch-core ${COMPATIBLE_SWITCH_VERSION}.`
    );
    return null;
  }
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
 * Move a stack past the last version that can read a Matrix homeserver, copying
 * its history first.
 *
 * Not optional and not skippable. The next version deletes the transport, the
 * backfill and Tuwunel, so a stack that crosses without copying loses every
 * message sent before Switch moved to the Postgres store — silently, during an
 * update nobody asked to be a migration. A failed copy therefore fails the
 * start: the stack stays on the version it is on, which is where it can still
 * be fixed, and trying again is free because the copy skips what it has
 * already done.
 *
 * Returns null when there is nothing to do: no boundary crossed, no readable
 * deployed version, or a dev checkout build (which carries no comparable
 * version, and whose data is not somebody's install).
 */
async function migrateOffMatrix(
  host: ServerHost,
  checkoutRoot: string | null,
  onMessage: (message: string) => void,
  onLog: (line: string) => void
): Promise<StartLocalServerResult | null> {
  if (checkoutRoot !== null) return null;
  const deployed = await readDeployedVersion(host);
  if (deployed.kind !== 'deployed' || deployed.version === CHECKOUT_IMAGE_TAG) return null;
  if (!crossesMatrixBoundary(deployed.version, COMPATIBLE_SWITCH_VERSION)) return null;

  log.info(
    `managed-switch-server: ${host.label} is crossing the Matrix boundary ` +
      `(${deployed.version} → ${COMPATIBLE_SWITCH_VERSION}); backfilling first`
  );
  // Bring the stack up as it stands. The backfill reads the homeserver and the
  // database, and this is the last moment both are still here.
  onMessage('Starting the current version to copy your room history…');
  await composeUp(host, onLog, false);

  onMessage('Copying room history out of the message server…');
  const backfill = await runBackfill(host, onLog);
  if (backfill.ok) return null;
  return {
    kind: 'matrix-migration-failed',
    deployed: deployed.version,
    expected: COMPATIBLE_SWITCH_VERSION,
    detail: backfill.detail,
  };
}

export type StackSettings = { secrets: LocalServerSecrets; ports: LocalServerPorts };

/**
 * Where a start's ports and credentials come from (CHOO-2893).
 *
 * A remote stack is shared, so its settings are read off the host and a
 * desktop's own copy is only a cache of them. New credentials are made in
 * exactly one case — nothing of the stack on the host at all — because making
 * them anywhere else locks the stack out of the Postgres volume its first
 * credentials created, and takes down a server someone else is using.
 */
type StartPlan =
  /** The host's own settings. Every remote start that finds a stack. */
  | { kind: 'adopt'; stack: Extract<StackOnHost, { kind: 'present' }> }
  /** Nothing on the host, or the local stack, which nobody else shares: this
   * desktop's copy, or new credentials when it has none. */
  | { kind: 'fresh' }
  /** The host could not say, or its settings have gaps, and this desktop
   * holds a copy of what the stack last ran with — one that agrees with every
   * setting the host does hold. The copy is used — refusing would make a stack
   * its own starter can no longer start — and the degradation is logged. */
  | { kind: 'cached'; reason: string }
  /** Starting here could replace the credentials of a stack that is already
   * there. Nothing may be written. */
  | { kind: 'refused'; message: string };

async function planStart(host: ServerHost): Promise<StartPlan> {
  if (host.sharedState === null) return { kind: 'fresh' };
  const stack = await inspectStack(host.sharedState);
  switch (stack.kind) {
    case 'present':
      return { kind: 'adopt', stack };
    case 'absent':
      return { kind: 'fresh' };
    case 'unshared':
      return { kind: 'refused', message: unsharedStackMessage(host.label, stack.ownerDir) };
    case 'incomplete':
    case 'unreadable': {
      const reason =
        stack.kind === 'incomplete'
          ? `its settings are missing ${stack.missing.join(', ')}`
          : stack.reason;
      const secrets = await readSecrets(host);
      const ports = await readPersistedPorts(host);
      if (secrets === null || ports === null) {
        return {
          kind: 'refused',
          message:
            `Could not read the Switch server's settings on ${host.label} (${reason}). ` +
            `Starting without them could replace the credentials of a server that is already ` +
            `there, so nothing was changed.`,
        };
      }
      // A copy that disagrees with what the host does hold is from another
      // generation of the stack — typically from before someone else reset it
      // — and starting from it would lock the stack out of its database.
      if (stack.kind === 'incomplete') {
        const disagreeing = keysDisagreeing(stack.raw, { secrets, ports });
        if (disagreeing.length > 0) {
          return {
            kind: 'refused',
            message:
              `The Switch server's settings on ${host.label} are missing ` +
              `${stack.missing.join(', ')}, and this desktop's copy of them is out of date ` +
              `(${disagreeing.join(', ')} differ from the host's), so it cannot fill the gap. ` +
              `Starting from it would lock the server out of its database, so nothing was changed.`,
          };
        }
      }
      log.warn(
        `managed-switch-server: could not read the stack's settings on ${host.label}; ` +
          `starting from this desktop's copy of them`,
        { reason }
      );
      return { kind: 'cached', reason };
    }
  }
}

/** The host's settings as a full bundle, kept as this desktop's copy. */
async function adoptSettings(
  host: ServerHost,
  stack: Extract<StackOnHost, { kind: 'present' }>
): Promise<StackSettings> {
  const { secrets } = withRuntimePassword({
    ...stack.env.secrets,
    dbRuntimePassword: stack.env.secrets.dbRuntimePassword ?? '',
  });
  await storeSecrets(host, secrets);
  await rememberPorts(host, stack.env.ports);
  return { secrets, ports: stack.env.ports };
}

/**
 * Take up a stack that is running on a shared host without touching it: keep
 * its settings as this desktop's copy, and bring this account's working dir in
 * step so compose — for Stop, Restart and the status probes — reads the same
 * `.env` the stack runs with. The compose file is written only where there is
 * none, since rewriting it is a start's business. A stack this account started
 * before settings were shared is published on the way, so the next person can
 * join it.
 *
 * Shared by joining a stack and by picking one back up at launch, which is the
 * same act from a Console that has joined before.
 */
export async function adoptRunningStack(
  host: ServerHost,
  stack: Extract<StackOnHost, { kind: 'present' }>
): Promise<StackSettings> {
  const shared = host.sharedState;
  if (shared === null) {
    throw new Error(`The stack on ${host.label} is not shared, so there is nothing to adopt.`);
  }
  const settings = await adoptSettings(host, stack);
  if ((await host.readFile(COMPOSE_FILE_NAME)) === null) {
    await host.writeFile(COMPOSE_FILE_NAME, bundledComposeYaml());
  }
  if (stack.source === 'published') {
    await host.writeFile(ENV_FILE_NAME, stack.raw, 0o600);
  } else if (!stack.published) {
    await publishEnv(shared, stack.raw);
  }
  return settings;
}

async function settingsFor(
  host: ServerHost,
  plan: Exclude<StartPlan, { kind: 'refused' }>
): Promise<StackSettings> {
  if (plan.kind === 'adopt') return adoptSettings(host, plan.stack);
  // `cached` was only chosen because a copy exists, so neither call mints.
  return { secrets: await loadOrCreateSecrets(host), ports: await resolvePorts(host) };
}

/**
 * Register the running stack, make it the active server, and sign in as its
 * admin. Switch Console generated that password, so it signs in on the user's
 * behalf rather than showing a login wall for a secret they never saw. A
 * failed sign-in does not fail the caller — the stack is healthy, and the
 * server view falls back to its sign-in panel.
 */
async function registerAndSignIn(
  ref: ManagedServerRef,
  serverName: string,
  settings: StackSettings,
  onMessage: (message: string) => void
): Promise<string> {
  const server = await ensureManagedServer(
    {
      name: serverName,
      gatewayUrl: gatewayUrlFor(settings.ports),
      apiUrl: apiUrlFor(settings.ports),
    },
    ref
  );
  await setActiveServerId(server.id);

  onMessage('Signing in…');
  const login = await passwordLogin(
    server,
    LOCAL_SERVER_ADMIN_EMAIL,
    settings.secrets.gatewayAdminPassword
  );
  if (!login.success) {
    log.warn('managed-switch-server: auto sign-in failed; server will show a sign-in prompt', {
      error: login.error,
    });
  }

  await resolveAgentServers();
  return server.id;
}

/**
 * Full start pipeline: detect Docker → plan where the settings come from →
 * refuse a downgrade → materialise compose + `.env` → publish the `.env` →
 * `compose up` → establish networking → health-gate → register + activate →
 * silent admin sign-in → reconcile agent servers. Returns without registering
 * anything if Docker is unavailable, the host's stack cannot safely be started
 * from here, the stack is newer than this build, or it never turns healthy.
 *
 * Doubles as the update path: the `.env` and compose file are re-materialised
 * from this build every time, so `compose up -d` on an already-running stack
 * re-pulls the newly pinned tags and recreates only the changed containers,
 * leaving the data volumes in place for switch-core to migrate forward. On a
 * shared host that is an update for everyone using the stack, which is why the
 * settings it writes are the host's own rather than this desktop's.
 *
 * With `checkoutRoot` set (dev only) the images are built from that working
 * tree on every start instead of pulled, and tagged {@link CHECKOUT_IMAGE_TAG}
 * so nothing downstream mistakes them for a release.
 */
export async function startStack(opts: StartStackOptions): Promise<StartLocalServerResult> {
  const { host, ref, serverName, onMessage, onLog, signal, checkoutRoot } = opts;

  const docker = await host.detectDocker();
  if (!docker.available) {
    return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
  }

  if (host.sharedState !== null) onMessage('Reading the server’s settings on the host…');
  const plan = await planStart(host);
  if (plan.kind === 'refused') {
    log.error(`managed-switch-server: refusing to start the stack on ${host.label}`, {
      reason: plan.message,
    });
    return { kind: 'error', message: plan.message };
  }

  // Bring this account's working dir in step with the stack before anything
  // reads it. Another account may have started, updated or reset the stack
  // since this one last did, and the version check below reads the `.env`
  // compose would use — which has to be the stack's, not a stale copy.
  if (plan.kind === 'adopt' && plan.stack.source === 'published') {
    await host.writeFile(ENV_FILE_NAME, plan.stack.raw, 0o600);
  }

  onMessage('Checking the deployed version…');
  const downgrade = await refuseDowngrade(host, checkoutRoot);
  if (downgrade) return downgrade;

  // Copy the homeserver's history across before the upgrade removes the only
  // thing that can read it. Runs against the stack as currently deployed, so
  // it must happen before the compose file and `.env` are re-materialised for
  // the new version — those are what would take Tuwunel away.
  const migration = await migrateOffMatrix(host, checkoutRoot, onMessage, onLog);
  if (migration) return migration;

  onMessage('Preparing configuration…');
  await host.writeFile(COMPOSE_FILE_NAME, bundledComposeYaml());
  if (checkoutRoot !== null) {
    await host.writeFile(BUILD_OVERRIDE_FILE_NAME, checkoutBuildOverrideYaml(checkoutRoot));
  }
  const settings = await settingsFor(host, plan);
  // Read here rather than taken from the caller: a start is the moment the
  // user's answer reaches the server, and no supervisor can forget to carry it.
  const telemetryEnabled = await telemetryConsent();
  const env = buildEnvFile({
    version: checkoutRoot !== null ? CHECKOUT_IMAGE_TAG : COMPATIBLE_SWITCH_VERSION,
    registry: GHCR_REGISTRY,
    namespace: RELEASE_REPO_OWNER,
    ports: settings.ports,
    secrets: settings.secrets,
    sessionDemo: checkoutRoot !== null,
    telemetryEnabled,
  });
  await host.writeFile(ENV_FILE_NAME, env, 0o600);

  // Published before compose reads it, so the shared copy always names what
  // the stack was last asked to run with — including when `up` then fails
  // halfway. A start whose settings nobody else can read is the state that
  // led the next person's Console to overwrite them, so this failing fails
  // the start rather than being logged past.
  if (host.sharedState !== null) {
    onMessage('Sharing the server’s settings on the host…');
    await publishEnv(host.sharedState, env);
  }

  onMessage(
    checkoutRoot !== null
      ? `Building images from ${checkoutRoot} and starting containers…`
      : 'Starting containers (pulling images if needed)…'
  );
  await composeUp(host, onLog, checkoutRoot !== null);

  // Make the published ports reachable from the desktop (no-op locally; a
  // mirrored SSH forward remotely) BEFORE the health probe, so the probe takes
  // the same path clients will.
  await host.establishNetworking(settings.ports);

  onMessage('Waiting for the server to become healthy…');
  const healthy = await waitForHealth(gatewayUrlFor(settings.ports), { signal });
  if (!healthy) {
    return { kind: 'error', message: 'The server did not become healthy in time.' };
  }

  const serverId = await registerAndSignIn(ref, serverName, settings, onMessage);
  return { kind: 'started', serverId, telemetryEnabled };
}

export type ConnectStackOptions = {
  host: ServerHost;
  ref: ManagedServerRef;
  serverName: string;
  onMessage: (message: string) => void;
  /** Aborts an in-flight health wait (cancel/quit). */
  signal: AbortSignal;
};

/**
 * Join a stack that is already running on a shared host, from a Console that
 * did not start it (CHOO-2893): read its settings off the host, forward its
 * ports, register it and sign in — without writing its `.env` differently or
 * running compose, so nobody else using it notices.
 *
 * This account's working dir is brought in step with the stack on the way, so
 * Stop and Restart work from here afterwards. A stack this account started
 * before settings were shared is published, so the next person can join too.
 *
 * Anything short of a running stack whose settings this account can read is
 * reported rather than worked around: a stopped stack is for Start, and
 * nothing here ever makes new credentials.
 */
export async function connectStack(opts: ConnectStackOptions): Promise<ConnectRemoteServerResult> {
  const { host, ref, serverName, onMessage, signal } = opts;
  const shared = host.sharedState;
  if (shared === null) {
    throw new Error(`The stack on ${host.label} is not shared, so there is nothing to connect to.`);
  }

  const docker = await host.detectDocker();
  if (!docker.available) {
    return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
  }

  onMessage('Reading the server’s settings on the host…');
  const stack = await inspectStack(shared);
  switch (stack.kind) {
    case 'absent':
      return { kind: 'absent' };
    case 'unshared':
      return {
        kind: 'unshared',
        ownerDir: stack.ownerDir,
        message: unsharedStackMessage(host.label, stack.ownerDir),
      };
    case 'incomplete':
      return {
        kind: 'error',
        message:
          `The Switch server on ${host.label} is set up, but its settings are missing ` +
          `${stack.missing.join(', ')}, so this Console cannot join it.`,
      };
    case 'unreadable':
      return {
        kind: 'error',
        message: `Could not read the Switch server's settings on ${host.label}: ${stack.reason}`,
      };
    case 'present':
      break;
  }
  if (!stack.running) return { kind: 'not-running' };

  onMessage('Preparing this account’s copy of the server’s settings…');
  const settings = await adoptRunningStack(host, stack);

  await host.establishNetworking(settings.ports);

  onMessage('Waiting for the server to answer…');
  const gatewayUrl = gatewayUrlFor(settings.ports);
  if (!(await waitForHealth(gatewayUrl, { signal }))) {
    return {
      kind: 'error',
      message: `The Switch server on ${host.label} is running, but did not answer at ${gatewayUrl}.`,
    };
  }

  const serverId = await registerAndSignIn(ref, serverName, settings, onMessage);
  return { kind: 'connected', serverId, deployedVersion: stack.env.version };
}

/** Stop the stack's containers and tear down networking (leaves data + config). */
export async function stopStack(host: ServerHost): Promise<void> {
  await composeDown(host, false);
  await host.teardownNetworking();
}

/** Destroy the stack, its data volumes, stored secrets, and port choice — the
 * irreversible clean-slate reset. On a shared host the published settings go
 * too, since the credentials in them now open nothing; the record of who did
 * this is kept. */
export async function resetStack(host: ServerHost): Promise<void> {
  await composeDown(host, true);
  await host.teardownNetworking();
  if (host.sharedState !== null) await withdrawPublishedEnv(host.sharedState);
  await clearSecrets(host);
  await clearPorts(host);
}
