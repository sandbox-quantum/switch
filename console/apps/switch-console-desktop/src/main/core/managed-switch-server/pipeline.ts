import { passwordLogin } from '@main/core/switch-servers/auth';
import {
  assertManagedServerUrlFree,
  ensureManagedServer,
  setActiveServerId,
} from '@main/core/switch-servers/servers-store';
import { reconcileServerWorkspaces } from '@main/core/workspaces/reconcile-workspaces';
import { log } from '@main/lib/logger';
import { COMPATIBLE_SWITCH_VERSION, RELEASE_REPO_OWNER } from '@shared/app-identity';
import {
  CHECKOUT_IMAGE_TAG,
  type ConnectRemoteServerResult,
  othersRecentlySeen,
  type StartLocalServerResult,
} from '@shared/core/managed-switch-server/managed-switch-server';
import type { ManagedServerRef } from '@shared/core/switch-servers/switch-servers';
import { currentFlintEnv } from '../telemetry/config';
import { bundledComposeYaml } from './bundled-compose';
import { checkoutBuildOverrideYaml } from './checkout-build';
import { composeDown, composeUp } from './compose';
import { readRegister } from './console-register';
import {
  BUILD_OVERRIDE_FILE_NAME,
  COMPOSE_FILE_NAME,
  ENV_FILE_NAME,
  ENV_STAMP_FILE_NAME,
  GHCR_REGISTRY,
  LOCAL_SERVER_ADMIN_EMAIL,
} from './constants';
import { classifyVersionDrift, readDeployedVersion } from './deployed-version';
import { buildEnvFile, keysDisagreeing, telemetryRequested } from './env-file';
import { apiUrlFor, gatewayUrlFor, type LocalServerPorts } from './free-port';
import { waitForHealth } from './health';
import type { ServerHost } from './host/types';
import { finishUpgrade, type OwedUpgrade, prepareUpgrade } from './managed-upgrade';
import { crossesMatrixBoundary, runBackfill } from './matrix-migration';
import { clearPorts, readPersistedPorts, rememberPorts, resolvePorts } from './ports';
import { type LocalServerSecrets, withNewerSecrets } from './secret-values';
import { clearSecrets, loadOrCreateSecrets, readSecrets, storeSecrets } from './secrets';
import type { ServerLease } from './stack-lock';
import {
  driftOf,
  inspectStack,
  publishEnv,
  stampPublishedEnv,
  type StackOnHost,
  type StackStateHost,
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
  /** Whether to make this the active server. False for an upgrade Console runs
   * on its own, which must not switch the user away from what they have open. */
  activate: boolean;
  /** Coarse step messages for the UI ("Pulling images…"). */
  onMessage: (message: string) => void;
  /** Live compose output lines for the UI log tail. */
  onLog: (line: string) => void;
  /** Fired before a start that moves the stack forward to this build's pin, so
   * the supervisor can hold sessions until it finishes. */
  onUpgrade: (upgrade: OwedUpgrade) => void;
  /** Aborts an in-flight health wait (stop/cancel/quit). */
  signal: AbortSignal;
  /** Dev-only: root of the Switch checkout to build the stack's images from,
   * instead of pulling this build's pinned images. Null is the released path. */
  checkoutRoot: string | null;
  /** The shared stack's lock, held for the whole start. Null for the local
   * stack, which nobody shares. */
  lease: ServerLease | null;
};

/** The shared state and its lock, or null for a stack nobody shares. A lock
 * without shared state, or shared state without a lock, throws. */
function sharedUnderLock(
  host: ServerHost,
  lease: ServerLease | null
): { state: StackStateHost; lease: ServerLease } | null {
  if (host.sharedState !== null && lease !== null) return { state: host.sharedState, lease };
  if (host.sharedState === null && lease === null) return null;
  throw new Error(
    host.sharedState !== null
      ? `Refusing to change the shared stack on ${host.label} without holding its lock.`
      : `The stack on ${host.label} is not shared, so it has no lock to hold.`
  );
}

/** {@link sharedUnderLock} for an operation only a shared stack has; `what`
 * names it in the error. */
function requireSharedUnderLock(
  host: ServerHost,
  lease: ServerLease,
  what: string
): { state: StackStateHost; lease: ServerLease } {
  if (host.sharedState === null) {
    throw new Error(`The stack on ${host.label} is not shared, so there is nothing to ${what}.`);
  }
  return { state: host.sharedState, lease };
}

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
 * Where a start's ports and credentials come from. New credentials are made
 * only when nothing of the stack is on the host: made anywhere else, they lock
 * the stack out of the Postgres volume its first credentials created.
 */
type StartPlan =
  | { kind: 'adopt'; stack: Extract<StackOnHost, { kind: 'present' }> }
  /** Nothing on the host, or the local stack: this desktop's copy, or new
   * credentials when it has none. */
  | { kind: 'fresh' }
  /** The host's settings have gaps, and this desktop's copy agrees with every
   * setting the host does hold, so the copy fills them. */
  | { kind: 'cached'; reason: string }
  /** Starting could replace the credentials of a stack already there. */
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
    case 'unreadable':
      // Not answered from this desktop's copy: someone may have reset the stack
      // since, and publishing stale credentials would lock everyone out.
      return {
        kind: 'refused',
        message:
          `Could not read the Switch server's settings on ${host.label} (${stack.reason}). ` +
          `Starting from this desktop's copy could put back credentials someone has since ` +
          `replaced, so nothing was changed. Try again once the host answers.`,
      };
    case 'incomplete': {
      const reason = `its settings are missing ${stack.missing.join(', ')}`;
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
      // A copy that disagrees with the host predates a reset of the stack.
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
      log.warn(
        `managed-switch-server: the stack's settings on ${host.label} are partial; ` +
          `filling them from this desktop's copy`,
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
  // A `.env` from before the database role split has no runtime password; one
  // is made here, and the next start gives the role it. One from before
  // SECRET_KEYS takes this desktop's, if it has one — a server may already
  // have stored credentials under it — and a fresh one otherwise.
  const { secrets } = withNewerSecrets({
    ...stack.env.secrets,
    dbRuntimePassword: stack.env.secrets.dbRuntimePassword ?? '',
    secretKeys: stack.env.secrets.secretKeys ?? (await readSecrets(host))?.secretKeys ?? '',
  });
  await storeSecrets(host, secrets);
  await rememberPorts(host, stack.env.ports);
  return { secrets, ports: stack.env.ports };
}

/**
 * Take up a stack running on a shared host without touching it: keep its
 * settings as this desktop's copy, bring the working dir in step, and publish
 * its `.env` if it predates shared settings so the next person can join.
 */
export async function adoptRunningStack(
  host: ServerHost,
  stack: Extract<StackOnHost, { kind: 'present' }>,
  lease: ServerLease
): Promise<StackSettings> {
  const shared = requireSharedUnderLock(host, lease, 'adopt');
  const settings = await adoptSettings(host, stack);
  await bringWorkingDirInStep(host, stack);
  if (!stack.published) await publishEnv(shared.state, stack.raw, shared.lease);
  return settings;
}

/** Make this account's working dir match a stack found on the host, so compose
 * (version check, upgrade backup, Stop, Restart) reads what the stack runs with. */
export async function bringWorkingDirInStep(
  host: ServerHost,
  stack: Extract<StackOnHost, { kind: 'present' }>
): Promise<void> {
  if (stack.source === 'published') {
    await host.writeFile(ENV_FILE_NAME, stack.raw, 0o600);
    await writeEnvStamp(host, stack.stamp);
  }
  // At this build's version the bundled file is what the stack runs, and Stop
  // and Reset must know every service. At another version an existing file is
  // left for a start to rewrite after any backup has read it; a missing one
  // gets this build's, since a published stack is past the Matrix line.
  if (driftOf(stack) === null || (await host.readFile(COMPOSE_FILE_NAME)) === null) {
    await host.writeFile(COMPOSE_FILE_NAME, bundledComposeYaml());
  }
}

/** Record which database this account's `.env` was written for. Null removes
 * the record, so a stale one cannot vouch for it. */
async function writeEnvStamp(host: ServerHost, stamp: string | null): Promise<void> {
  if (stamp === null) await host.removeFile(ENV_STAMP_FILE_NAME);
  else await host.writeFile(ENV_STAMP_FILE_NAME, `${stamp}\n`, 0o600);
}

/**
 * Whether a start shares usage data. This Console's "no" always applies; its
 * "yes" only where it overrides nobody's "no": the stack already shares, or
 * nobody else has used it lately. An unreadable register counts as others.
 */
async function shareUsageData(
  host: ServerHost,
  plan: StartPlan,
  consent: boolean
): Promise<boolean> {
  if (!consent || host.sharedState === null) return consent;
  // The register is read whatever the plan: it outlives a reset, and a stack
  // with partial settings is still someone's.
  if (plan.kind === 'adopt' && telemetryRequested(plan.stack.raw)) return true;
  try {
    const others = othersRecentlySeen(await readRegister(host.sharedState), new Date());
    if (others.length === 0) return true;
  } catch (error) {
    log.warn(`managed-switch-server: could not read who uses the server on ${host.label}`, {
      error,
    });
  }
  log.info(
    `managed-switch-server: the server on ${host.label} does not share usage data and others ` +
      `use it, so this start keeps it off`
  );
  return false;
}

async function settingsFor(
  host: ServerHost,
  plan: Exclude<StartPlan, { kind: 'refused' }>
): Promise<StackSettings> {
  if (plan.kind === 'adopt') return adoptSettings(host, plan.stack);
  // `cached` was only chosen because a copy exists, so neither call mints.
  return { secrets: await loadOrCreateSecrets(host), ports: await resolvePorts(host) };
}

/** Re-pick a fresh stack's remembered ports when one is now taken here:
 * nothing on the host depends on them yet. */
async function portsReachableHere(
  host: ServerHost,
  plan: Exclude<StartPlan, { kind: 'refused' }>,
  settings: StackSettings
): Promise<StackSettings> {
  if (plan.kind !== 'fresh') return settings;
  try {
    await host.checkNetworking(settings.ports);
    return settings;
  } catch (error) {
    log.info(`managed-switch-server: choosing new ports for a new stack on ${host.label}`, {
      reason: error instanceof Error ? error.message : String(error),
    });
    const ports = await host.pickFreePorts();
    await rememberPorts(host, ports);
    return { ...settings, ports };
  }
}

/**
 * Register the stack, activate it if asked, and sign in as its admin with the
 * password Switch Console generated. A failed sign-in is only logged: the
 * server view falls back to its sign-in panel.
 */
async function registerAndSignIn(
  ref: ManagedServerRef,
  serverName: string,
  settings: StackSettings,
  activate: boolean,
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
  if (activate) await setActiveServerId(server.id);

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
  } else {
    // The user never sees a login form for a managed stack, so this is the only
    // sign-in it will ever have — without matching the workspaces here, its
    // placeholder one would stay unmatched until some later launch happened to.
    await reconcileServerWorkspaces(server.id).catch((error: unknown) => {
      log.warn('managed-switch-server: signed in, but could not read the account’s workspaces', {
        server: server.id,
        error: String(error),
      });
    });
  }

  return server.id;
}

/**
 * Full start pipeline: detect Docker → plan where the settings come from →
 * refuse a downgrade → back up and journal an upgrade → materialise compose +
 * `.env` → publish the `.env` → `compose up` → establish networking →
 * health-gate → register (+ activate) → silent admin sign-in → reconcile agent
 * servers → close the upgrade journal. Returns without registering
 * anything if Docker is unavailable, the host's stack cannot safely be started
 * from here, the stack is newer than this build, or it never turns healthy.
 *
 * Doubles as the update path: the `.env` and compose file are re-materialised
 * from this build every time, so `compose up -d` on an already-running stack
 * re-pulls the newly pinned tags and recreates only the changed containers,
 * leaving the data volumes in place for switch-core to migrate forward. A
 * stack behind the pin has its database dumped first (see managed-upgrade.ts).
 *
 * With `checkoutRoot` set (dev only) the images are built from that working
 * tree on every start instead of pulled, and tagged {@link CHECKOUT_IMAGE_TAG}
 * so nothing downstream mistakes them for a release.
 */
export async function startStack(opts: StartStackOptions): Promise<StartLocalServerResult> {
  const {
    host,
    ref,
    serverName,
    activate,
    onMessage,
    onLog,
    onUpgrade,
    signal,
    checkoutRoot,
    lease,
  } = opts;
  const shared = sharedUnderLock(host, lease);

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

  // Before anything reads the working dir: another account may have changed
  // the stack since, and the version check below reads this `.env`.
  if (plan.kind === 'adopt') {
    await bringWorkingDirInStep(host, plan.stack);
  } else if (plan.kind === 'fresh' && host.sharedState !== null) {
    // The working dir belongs to a stack that is gone. Left there, its version
    // would pass for the deployed one: a false downgrade refusal, or a backup
    // of a database that does not exist.
    await host.removeFile(ENV_FILE_NAME);
    await host.removeFile(ENV_STAMP_FILE_NAME);
    await finishUpgrade(host);
  }

  // Check this Console can reach the stack before changing it: a port clash
  // found only after compose would leave everyone else's server restarted and
  // this Console without it.
  const settings = await portsReachableHere(host, plan, await settingsFor(host, plan));
  await host.checkNetworking(settings.ports);
  await assertManagedServerUrlFree(gatewayUrlFor(settings.ports), ref);

  onMessage('Checking the deployed version…');
  const downgrade = await refuseDowngrade(host, checkoutRoot);
  if (downgrade) return downgrade;

  // Back the database up before anything can migrate it: the Matrix backfill
  // below already starts the stack, and the rewrite after it moves the pin.
  const upgrade = await prepareUpgrade(host, checkoutRoot, onMessage, onUpgrade);

  // Copy the homeserver's history across before the upgrade removes the only
  // thing that can read it. Runs against the stack as currently deployed, so
  // it must happen before the compose file and `.env` are re-materialised for
  // the new version — those are what would take Tuwunel away.
  // Compose cannot check the lock atomically the way publishing does, so a
  // Console that lost it stops here.
  await shared?.lease.assertHeld();
  const migration = await migrateOffMatrix(host, checkoutRoot, onMessage, onLog);
  if (migration) return migration;

  onMessage('Preparing configuration…');
  await host.writeFile(COMPOSE_FILE_NAME, bundledComposeYaml());
  if (checkoutRoot !== null) {
    await host.writeFile(BUILD_OVERRIDE_FILE_NAME, checkoutBuildOverrideYaml(checkoutRoot));
  }
  // Read here rather than taken from the caller: a start is the moment the
  // user's answer reaches the server, and no supervisor can forget to carry it.
  const telemetryEnabled = await shareUsageData(host, plan, await telemetryConsent());
  const env = buildEnvFile({
    version: checkoutRoot !== null ? CHECKOUT_IMAGE_TAG : COMPATIBLE_SWITCH_VERSION,
    registry: GHCR_REGISTRY,
    namespace: RELEASE_REPO_OWNER,
    ports: settings.ports,
    secrets: settings.secrets,
    telemetryEnabled,
    telemetryEnvironment: currentFlintEnv(),
  });
  await host.writeFile(ENV_FILE_NAME, env, 0o600);

  // Published before compose runs, so the shared copy names what the stack was
  // last asked to run with even if `up` fails halfway. A failure fails the
  // start: unpublished settings get overwritten by the next Console.
  let publishedStamp: string | null = null;
  if (shared !== null) {
    onMessage('Sharing the server’s settings on the host…');
    publishedStamp = await publishEnv(shared.state, env, shared.lease);
  }

  onMessage(
    checkoutRoot !== null
      ? `Building images from ${checkoutRoot} and starting containers…`
      : 'Starting containers (pulling images if needed)…'
  );
  await composeUp(host, onLog, checkoutRoot !== null);
  // A copy published before its database existed is stamped now. The stack is
  // up, so a failure here is a warning, not a failed start.
  let warning: string | null = null;
  if (shared !== null) {
    try {
      await writeEnvStamp(
        host,
        publishedStamp ?? (await stampPublishedEnv(shared.state, shared.lease))
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log.error(`managed-switch-server: could not stamp the published settings on ${host.label}`, {
        error,
      });
      warning =
        `Started, but its settings on ${host.label} could not be stamped with its ` +
        `database (${reason}). Until the next start stamps them, a reset from a Console older ` +
        `than sharing could leave them looking current to the others.`;
    }
  }

  // Make the published ports reachable from the desktop (no-op locally; a
  // mirrored SSH forward remotely) BEFORE the health probe, so the probe takes
  // the same path clients will.
  await host.establishNetworking(settings.ports);

  onMessage('Waiting for the server to become healthy…');
  const healthy = await waitForHealth(gatewayUrlFor(settings.ports), { signal });
  if (!healthy) {
    return { kind: 'error', message: 'The server did not become healthy in time.' };
  }

  const serverId = await registerAndSignIn(ref, serverName, settings, activate, onMessage);
  if (upgrade) await finishUpgrade(host);
  return { kind: 'started', serverId, telemetryEnabled, warning };
}

export type ConnectStackOptions = {
  host: ServerHost;
  ref: ManagedServerRef;
  serverName: string;
  onMessage: (message: string) => void;
  /** Aborts an in-flight health wait (cancel/quit). */
  signal: AbortSignal;
  /** The stack's lock, so a stack half-way through someone else's start does
   * not read as stopped. Released once its settings are adopted. */
  lease: ServerLease;
};

/** `behind` is a stack at an older switch-core than this build pins, which the
 * caller updates as a start. */
export type ConnectStackResult =
  | Exclude<ConnectRemoteServerResult, { kind: 'cancelled' }>
  | { kind: 'behind'; deployed: string; expected: string };

/**
 * Join a stack already running on a shared host without running compose, so
 * nobody else using it notices. A stopped, older or unreadable stack is
 * reported rather than worked around, and nothing here makes new credentials.
 */
export async function connectStack(opts: ConnectStackOptions): Promise<ConnectStackResult> {
  const { host, ref, serverName, onMessage, signal, lease } = opts;
  const shared = requireSharedUnderLock(host, lease, 'connect to');

  const docker = await host.detectDocker();
  if (!docker.available) {
    return { kind: 'docker-unavailable', reason: docker.reason, detail: docker.detail };
  }

  onMessage('Reading the server’s settings on the host…');
  const stack = await inspectStack(shared.state);
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
  const drift = driftOf(stack);
  if (drift?.direction === 'upgrade') {
    return { kind: 'behind', deployed: drift.deployed, expected: drift.expected };
  }
  if (drift?.direction === 'downgrade') {
    return {
      kind: 'error',
      message:
        `The Switch server on ${host.label} runs switch-core ${drift.deployed}, newer than the ` +
        `${drift.expected} this Console runs, so this Console cannot use it. Update Switch ` +
        `Console, then connect.`,
    };
  }

  onMessage('Preparing this account’s copy of the server’s settings…');
  const settings = await adoptRunningStack(host, stack, lease);
  await lease.release();

  await host.establishNetworking(settings.ports);

  onMessage('Waiting for the server to answer…');
  const gatewayUrl = gatewayUrlFor(settings.ports);
  if (!(await waitForHealth(gatewayUrl, { signal }))) {
    return {
      kind: 'error',
      message: `The Switch server on ${host.label} is running, but did not answer at ${gatewayUrl}.`,
    };
  }

  const serverId = await registerAndSignIn(ref, serverName, settings, true, onMessage);
  return {
    kind: 'connected',
    serverId,
    deployedVersion: stack.runningVersion ?? stack.env.version,
  };
}

/** Stop the stack's containers and tear down networking (leaves data + config).
 * `lease` is the shared stack's lock, null for the local one. */
export async function stopStack(host: ServerHost, lease: ServerLease | null): Promise<void> {
  await sharedUnderLock(host, lease)?.lease.assertHeld();
  await composeDown(host, false);
  await host.teardownNetworking();
}

/** Destroy the stack, its data volumes, stored secrets, and port choice — the
 * irreversible clean-slate reset. On a shared host the published settings go
 * too, since their credentials now open nothing. */
export async function resetStack(host: ServerHost, lease: ServerLease | null): Promise<void> {
  const shared = sharedUnderLock(host, lease);
  await shared?.lease.assertHeld();
  await composeDown(host, true);
  await host.teardownNetworking();
  if (shared !== null) await withdrawPublishedEnv(shared.state, shared.lease);
  await clearSecrets(host);
  await clearPorts(host);
  // Nothing is left to resume. The backups stay on disk.
  await finishUpgrade(host);
}
