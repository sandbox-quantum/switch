import type { OpenAgentStream, ProviderReadiness } from '@switch-console/agent-providers';
import type { RestartNotice } from '@switch-console/agent-providers/box';
import { AgentHub } from './agent-hub';
import {
  AccessTokens,
  ControllerClient,
  type Fetch,
  isAccountSuspended,
  isCredentialRefused,
  isRevoked,
  isUpgradeRequired,
  type OpenWebSocket,
} from './api';
import type { BoxController, BoxControllerDeps } from './box/controller-box';
import {
  BROWSER_SIGN_IN_PROGRESS_MS,
  BROWSER_SIGN_IN_TIMEOUT_MS,
  signInWithBrowser,
} from './browser-login';
import { ConfigurationError } from './errors';
import { HubSocket } from './hub-socket';
import { errorMessage, type Logger } from './log';
import { processPendingOperations } from './operations';
import { isSafeSegment } from './paths';
import type { ProviderRechecks } from './provider-rechecks';
import { providersFor } from './providers';
import {
  type CredentialChange,
  definitionProblem,
  reconcile,
  type ReconcileDeps,
  startAgent,
} from './reconcile';
import { LocalRelay, RELAY_TOKEN_PREFIX } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentRuntime, GatewayRecord } from './runtime';
import {
  type AgentCursor,
  type Assignment,
  isProvider,
  type Provider,
  type StatusReport,
  statusReportSchema,
  type ToolStatus,
  type UpdatedBy,
} from './schemas';
import { type GivenLogin, registerSealingKey, SealedLogins, sealingKeys } from './sealed-logins';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import type { SelfUpdater } from './self-update';
import { SocketCalls } from './socket-calls';
import {
  noSessionMidTurn,
  type ProviderLocator,
  type ProviderSeed,
  ProviderStatuses,
  reportFingerprint,
  type SessionsSent,
  StatusCollector,
  sessionChangeEntries,
  sessionsSent,
  statusFingerprint,
} from './status';
import type { ControllerStore } from './store';
import { type ControllerFrame, runControllerStream } from './stream';

export type ControllerTiming = {
  /** The full resync safety net. */
  resyncMs: number;
  /** How often local state is looked at for a change worth reporting. */
  statusPollMs: number;
  /** The least time between two status reports. */
  statusMinGapMs: number;
  /** Used until the server says otherwise. */
  defaultReportWithinS: number;
  streamIdleMs: number;
  streamInitialBackoffMs: number;
  /**
   * The longest wait before reopening the controller stream. Kept short:
   * every agent on the controller is offline while the stream is down.
   */
  streamMaxBackoffMs: number;
  /**
   * How often Switch is asked again while it refuses the controller because
   * its owner is suspended: its agents are stopped meanwhile, so nobody waits
   * on it, and it is back within this long of the suspension being lifted.
   */
  streamSuspendedRetryMs: number;
  /** The most events held per agent while its agent host is not taking them. */
  eventBufferLimit: number;
};

export const DEFAULT_TIMING: ControllerTiming = {
  resyncMs: 10 * 60 * 1000,
  statusPollMs: 5_000,
  statusMinGapMs: 1_000,
  defaultReportWithinS: 60,
  // Five missed pings, at the 2 s Switch sends them.
  streamIdleMs: 10_000,
  streamInitialBackoffMs: 1_000,
  streamMaxBackoffMs: 8_000,
  streamSuspendedRetryMs: 60_000,
  eventBufferLimit: 5_000,
};

/**
 * The assignment with every agent stopped: what the controller holds, and
 * keeps on disk so a restart starts nothing, while Switch refuses it because
 * its owner is suspended. The next assignment it pulls once let in again says
 * how each agent should run.
 */
export function allStopped(held: Assignment): Assignment {
  return {
    ...held,
    agents: held.agents.map((entry) => ({ ...entry, desired_state: 'stopped' })),
  };
}

/**
 * How long an agent host restarted onto this controller's shared-host bundle
 * is left before it is restarted again, when the restart failed or it still
 * runs another bundle.
 */
export const OUTDATED_RESTART_RETRY_MS = 10 * 60 * 1000;

export type ControllerDeps = {
  store: ControllerStore;
  secrets: SecretStore;
  /**
   * Builds how agents run here, given the stream each agent's agent host hears
   * its events on and the folder agents with no directory of their own work in.
   */
  runtime: (
    openStream: (agentId: string) => OpenAgentStream,
    workspaces: string,
    /** Box mode only: posts an agent's restart line through this controller, keyed by its turn. */
    restartNotice?: (agentId: string) => RestartNotice
  ) => AgentRuntime;
  /** Tries a provider's own login with a test prompt; absent where agents run as other users. */
  verifyLogin?: (provider: Provider, binaryPath: string) => Promise<ProviderReadiness> | null;
  locator: ProviderLocator;
  /**
   * Requests to check every provider again now, served while the controller
   * runs. `refreshPath` runs first, so a CLI installed since is found.
   */
  rechecks: ProviderRechecks;
  refreshPath: () => Promise<void>;
  /** Provider checks made before this controller started, taken as its own (`ProviderStatuses.seed`). */
  providerSeed: ProviderSeed;
  /** `git`, `gh` and vendor tools, as sessions here would be set up with them (`toolStatuses`). */
  tools: () => Promise<ToolStatus[]>;
  fetch: Fetch;
  /** Opens the controller's connection to Switch. */
  openWebSocket: OpenWebSocket;
  log: Logger;
  /** Where disk space is measured and provider checks run. */
  dataDir: string;
  /** Where agents' working directories go when their definition names none, for a server. */
  workspacesFor: (server: string) => string;
  version: string;
  /** Which machine, OS account and data folder this is (`readDeviceId`), or null when unknown. */
  deviceId: string | null;
  /** Who moves it onto another release, as its status reports to Switch. */
  updatedBy: UpdatedBy;
  /**
   * Follows the release Switch names for this controller; null where Switch
   * Console updates it instead.
   */
  selfUpdate: SelfUpdater | null;
  /** Whether ending with `restarting` starts this controller again: a service, or Switch Console. */
  supervised: boolean;
  /** Box mode (`--box` on a box image): only the box's providers are offered (`providersFor`). */
  box: boolean;
  /**
   * Box mode only: what a box's controller runs beyond every controller's
   * (the valve, resting agents, the provider gateway, a split box's
   * launcher). Read only when `box` is set, and loaded then.
   */
  boxDeps?: BoxControllerDeps;
  now: () => number;
  random: () => number;
  timing: ControllerTiming;
};

/**
 * `taken_over`: another instance of this controller opened the controller
 * stream after this one. Restarting would take it straight back, so this one
 * ends instead.
 *
 * `upgrade_required` and `credential_invalid`: the server refused this
 * controller's protocol, or knows no controller by its credential. Both are
 * refusals the server marks not retryable, and asking again cannot change
 * them, so this one ends rather than retrying forever.
 *
 * `restarting`: the release Switch names is installed, and the controller
 * ends for its service to start it again on that release.
 */
export type ControllerExit =
  | 'stopped'
  | 'revoked'
  | 'taken_over'
  | 'upgrade_required'
  | 'credential_invalid'
  | 'restarting';

/**
 * Makes an agent's credentials file name the relay, its hub, and a token the
 * relay accepts: the token already in the file when it names both as they
 * listen now, a new one otherwise. Resolves true when the file was (re)written,
 * which a running agent host only reads when it starts, so it is restarted:
 * that is also what moves an agent host from before the hub onto it.
 */
function sameLogin(a: GivenLogin | null, b: GivenLogin | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.provider === b.provider &&
    a.revision === b.revision &&
    a.kind === b.kind &&
    a.credential === b.credential
  );
}

/**
 * Box mode only: how the provider gateway fronts an agent's login. The login
 * it fronts is never written to the agent's file, only its opaque gateway
 * record; `change` says what that changed, when the gateway decided it.
 */
export type FrontLogin = (
  agentId: string,
  login: GivenLogin | null,
  saved: GatewayRecord | null
) => { fileLogin: GivenLogin | null; record: GatewayRecord | null; change?: CredentialChange };

/**
 * In box mode, `box` is given and the answer says what changed (`'relay'`,
 * `'login'`, `'withdrawn'`, or false for nothing), so a login withdrawn
 * stops at once while a new one waits for the turn; with the provider gateway
 * on (`box.front`), a login it fronts is never written to the file. Desktop
 * and v1 give no `box`, and the answer is true or false as it always was.
 */
export async function ensureRelayCredentials(
  agentId: string,
  providerLogin: GivenLogin | null,
  deps: {
    runtime: AgentRuntime;
    relay: LocalRelay;
    log: Logger;
    box?: { front?: FrontLogin };
  }
): Promise<CredentialChange> {
  const current = await deps.runtime.readCredentials(agentId);
  const endpoint = deps.relay.endpoint;
  const hub = deps.relay.hubUrl;
  const relayCurrent =
    current !== null &&
    current.endpoint === endpoint &&
    current.hub === hub &&
    current.token.startsWith(RELAY_TOKEN_PREFIX);
  const fronted = deps.box?.front
    ? deps.box.front(agentId, providerLogin, current?.gateway ?? null)
    : { fileLogin: providerLogin, record: null };
  const fileLogin = fronted.fileLogin;
  const record = fronted.record;
  const fileLoginCurrent = sameLogin(current?.providerLogin ?? null, fileLogin);
  const loginCurrent = fileLoginCurrent && sameRecord(current?.gateway ?? null, record);
  if (current && relayCurrent && loginCurrent) {
    if (!deps.relay.isRegistered(agentId, current.token))
      deps.relay.register(agentId, current.token);
    return false;
  }
  // A login withdrawn or replaced: what the agent host wrote of it goes now,
  // even for an agent that is not started again.
  if (current?.providerLogin && !fileLoginCurrent)
    await deps.runtime.forgetProviderLogin(agentId).catch((error: unknown) => {
      deps.log.error('Could not remove a provider login Switch no longer gives an agent', {
        agentId,
        provider: current.providerLogin?.provider,
        error: errorMessage(error),
      });
    });
  const token = current && relayCurrent ? current.token : deps.relay.mint(agentId);
  if (current && relayCurrent && !deps.relay.isRegistered(agentId, token))
    deps.relay.register(agentId, token);
  await deps.runtime.writeCredentials(agentId, {
    endpoint,
    token,
    hub,
    providerLogin: fileLogin,
    ...(record ? { gateway: record } : {}),
  });
  deps.log.info('Wrote the agent’s relay credentials', {
    agentId,
    why: !current
      ? 'it had none'
      : !relayCurrent
        ? 'they named another endpoint, hub or a Switch key'
        : record
          ? 'its login goes through the provider gateway'
          : providerLogin
            ? `the ${providerLogin.provider} login given to this machine changed`
            : 'the login given to this machine is no longer used',
  });
  if (!deps.box) return true;
  // A login withdrawn must not stay in use while a turn finishes: only a
  // login given or changed waits for the turn. A login swapped inside the
  // gateway changes nothing the running host reads.
  return !(current && relayCurrent)
    ? 'relay'
    : fronted.change !== undefined
      ? fronted.change
      : fileLogin
        ? 'login'
        : 'withdrawn';
}

function sameRecord(a: GatewayRecord | null, b: GatewayRecord | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.token === b.token &&
    a.provider === b.provider &&
    a.kind === b.kind &&
    a.revision === b.revision
  );
}

/** Runs one task at a time, in order; a failed task does not stop the next. */
class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.tail.then(task);
    this.tail = next.then(
      () => {},
      () => {}
    );
    return next;
  }

  drain(): Promise<void> {
    return this.tail;
  }
}

/**
 * The controller's run loop, until `signal` fires, the server revokes it, or
 * another instance takes its stream over.
 *
 * It starts the local relay its agents' agent hosts make their Switch calls
 * through, exchanges its credential for an access token, and holds the
 * controller stream open: agent frames go to each agent's agent host, which runs
 * in this process (`AgentHub`), each connect and each `assignment.changed`
 * pulls the assignment (with its ETag) and reconciles, each
 * `operation.pending` runs the pending operations, and `credential.revoked`
 * — or any request refused as `controller_revoked` — stops every agent,
 * wipes the credential and ends the loop with `'revoked'`. A refusal saying
 * `account_suspended` (its owner is suspended) is not a revocation: every
 * agent is stopped by holding the assignment with each one stopped, the
 * credential is kept, and the stream asks again every
 * `streamSuspendedRetryMs`; once Switch lets it in, the assignment it pulls
 * starts them again. A full resync runs every ten minutes regardless. Status
 * goes out when something changes, and at least every `report_within_s`.
 *
 * Before any of that, the cached assignment is reconciled, so agents come back
 * after a reboot even while the server is unreachable.
 */
export async function runController(
  deps: ControllerDeps,
  signal: AbortSignal
): Promise<ControllerExit> {
  const { store, timing } = deps;
  // Box mode only: loaded here, so desktop and v1 never load it.
  const boxed: BoxController | null = deps.box
    ? new (await import('./box/controller-box')).BoxController(deps.boxDeps ?? {}, {
        log: deps.log,
        now: deps.now,
        dataDir: deps.dataDir,
        assignment: () => assignment,
        report: () => reporter?.request(),
        reconcileLocally: () => reconcileLocally(),
        run: (task) => queue.run(task),
        failed: (what, error) => failed(what, error),
        stopping: () => stop.signal.aborted,
      })
    : null;
  const log = boxed?.log ?? deps.log;
  const identity = store.identity();
  if (!identity)
    throw new ConfigurationError(
      `This controller is not enrolled: ${deps.dataDir} holds no identity. Run 'switch-agent-controller enroll --server <url> --code <code>' first.`
    );
  const credential = await deps.secrets.get(CONTROLLER_CREDENTIAL);
  if (!credential) {
    const revokedAt = store.revokedAt();
    if (boxed && revokedAt) {
      // An earlier run was revoked and wiped the credential (a box started
      // again after a pause and resume). End as revoked, as that run did: the
      // box's entrypoint then keeps this identity aside and enrols afresh with
      // the code in its Secret, if Switch gave it one.
      log.warn(
        'This controller was revoked earlier and its credential wiped; it needs enrolling again with a new code',
        { controllerId: identity.controllerId, revokedAt }
      );
      return 'revoked';
    }
    throw new ConfigurationError(
      revokedAt
        ? `This controller was revoked at ${revokedAt} and its credential wiped. Enroll it again with a new code.`
        : `The controller credential is missing from ${deps.secrets.description}. Enroll again with a new code.`
    );
  }
  const warning = deps.secrets.startupWarning();
  if (warning) log.warn(warning);
  log.info('Agent controller starting', {
    controllerId: identity.controllerId,
    server: identity.server,
    version: deps.version,
  });

  const stop = new AbortController();
  const forward = () => stop.abort();
  signal.addEventListener('abort', forward, { once: true });
  if (signal.aborted) stop.abort();

  const tokens = new AccessTokens({
    fetch: deps.fetch,
    server: identity.server,
    controllerId: identity.controllerId,
    credential: async () => credential,
    now: deps.now,
    log,
  });
  const client = new ControllerClient({
    fetch: deps.fetch,
    server: identity.server,
    controllerId: identity.controllerId,
    version: deps.version,
    tokens,
    openWebSocket: deps.openWebSocket,
  });
  const queue = new SerialQueue();
  const cached = store.cachedAssignment();
  if (cached.kind === 'unreadable') {
    log.warn('The saved assignment is not one this version reads; discarding it to pull it again', {
      detail: cached.detail,
    });
    store.discardAssignment();
  }
  let assignment: Assignment | null = cached.kind === 'saved' ? cached.assignment : null;
  let etag: string | null = cached.kind === 'saved' ? cached.etag : null;
  let reportWithinS = timing.defaultReportWithinS;
  let revocation: Promise<void> | null = null;
  let reporter: StatusReporter | null = null;

  const hub = new AgentHub({
    log,
    bufferLimit: timing.eventBufferLimit,
    onCursor: (agentId, cursor) =>
      store.saveCursor(agentId, cursor, new Date(deps.now()).toISOString()),
    onChange: () => reporter?.request(),
    ...boxed?.hubDeps(client, () => hub),
  });
  const workspaces = deps.workspacesFor(identity.server);
  const runtime = boxed
    ? deps.runtime(boxed.openStream(hub), workspaces, boxed.restartNotice(client))
    : deps.runtime((agentId) => (streamDeps) => hub.open(agentId, streamDeps), workspaces);
  boxed?.setRuntime(runtime);
  const hubSocket = (): HubSocket => {
    if (!boxed) return new HubSocket({ hub, log });
    const socket = new HubSocket({ hub, log, ...boxed.hubSocketDeps() });
    boxed.setHubSocket(socket);
    return socket;
  };
  // The agents' operations go to Switch on the controller's socket while it takes them.
  const calls = new SocketCalls();
  const relay = new LocalRelay({
    log,
    roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
    hub: hubSocket(),
    forwarder: new UpstreamForwarder({
      server: identity.server,
      auth: {
        token: () => tokens.get(),
        invalidate: (token) => tokens.invalidate(token),
        revoked: () => void revoke(),
      },
      log,
      calls,
    }),
  });
  /** The agents whose saved cursor the hub has been given. */
  const placed = new Set<string>();
  /** Resumes each newly assigned agent where this controller last confirmed it. */
  const placeAgents = (held: Assignment) => {
    const cursors = store.cursors();
    for (const entry of held.agents) {
      const agentId = entry.agent_id;
      if (placed.has(agentId)) continue;
      placed.add(agentId);
      const cursor = cursors.get(agentId);
      // Core may have attached the agent before the assignment that names it
      // was read: where it attached it is then where the hub already stands.
      if (cursor !== undefined && !hub.attachment(agentId)) hub.setCursor(agentId, cursor);
    }
  };
  if (assignment) placeAgents(assignment);
  const port = await relay.start(store.relayPort());
  store.saveRelayPort(port);
  log.info('Relay listening for this machine’s agents', { endpoint: relay.endpoint });
  await boxed?.startGateway();

  const revoke = (): Promise<void> => {
    revocation ??= (async () => {
      log.error(
        'This controller has been revoked: stopping every agent, wiping its credential and exiting.'
      );
      const agentIds = new Set([
        ...store.agents().map((row) => row.agentId),
        ...(assignment?.agents.map((entry) => entry.agent_id) ?? []),
      ]);
      for (const agentId of agentIds) {
        if (!isSafeSegment(agentId)) continue;
        relay.unregister(agentId);
        try {
          await runtime.stop(agentId, { wait: false });
          hub.forget(agentId);
          await runtime.deleteCredentials(agentId);
        } catch (error) {
          log.error('Could not stop an agent of the revoked controller', {
            agentId,
            error: errorMessage(error),
          });
        }
      }
      await deps.secrets.delete(CONTROLLER_CREDENTIAL);
      store.markRevoked(new Date(deps.now()).toISOString());
      stop.abort();
    })();
    return revocation;
  };

  /** Set when a refusal that cannot pass ends the run. */
  let refused: 'upgrade_required' | 'credential_invalid' | null = null;
  const refuse = (ending: 'upgrade_required' | 'credential_invalid') => {
    refused ??= ending;
    stop.abort();
  };

  let restarting = false;
  let restartReason: 'update' | 'requested' = 'update';
  const restart = () => {
    restarting = true;
    stop.abort();
  };
  // Asked for through Switch: taken up once the operation saying it will be
  // done is reported, so the person asking sees it succeed before it goes.
  let restartRequested = false;

  const failed = (what: string, error: unknown) => {
    if (isRevoked(error)) {
      void revoke();
      return;
    }
    if (isUpgradeRequired(error)) return refuse('upgrade_required');
    if (isCredentialRefused(error)) return refuse('credential_invalid');
    if (isAccountSuspended(error)) return suspend(errorMessage(error));
    log.warn(`${what} failed; it is retried on the next nudge, reconnect or resync.`, {
      error: errorMessage(error),
    });
  };

  const keys = await sealingKeys(deps.secrets);
  const sealed = keys
    ? new SealedLogins({ client, keys, controllerId: identity.controllerId })
    : null;
  if (!keys)
    log.info(
      'This controller keeps no key across starts (its credential is handed over), so provider logins given to the machine are not used; its own are.'
    );
  else
    void registerSealingKey(client, keys, log).then((registered) => {
      if (!registered) providers.disableGiven();
    });
  const offered = providersFor(deps.box);
  const providers = new ProviderStatuses({
    providers: offered,
    box: deps.box,
    locator: deps.locator,
    runtime,
    sealed,
    probeCwd: deps.dataDir,
    verify: deps.verifyLogin,
    now: deps.now,
    log,
    onChange: () => reporter?.request(),
    ...boxed?.providerDeps(),
  });
  providers.seed(deps.providerSeed);
  boxed?.setProviders(providers);
  const collector = new StatusCollector({
    store,
    runtime,
    providers,
    tools: deps.tools,
    attached: (agentId) => hub.attached(agentId),
    box: deps.box,
    dataDir: deps.dataDir,
    workspacesDir: workspaces,
    deviceId: deps.deviceId,
    version: deps.version,
    updatedBy: deps.updatedBy,
    now: deps.now,
    ...boxed?.collectorDeps(hub),
  });
  const reconcileDeps: ReconcileDeps = {
    store,
    runtime,
    offered,
    ensureCredentials: async (agentId, provider) =>
      ensureRelayCredentials(
        agentId,
        isProvider(provider) ? await providers.givenLogin(provider) : null,
        { runtime, relay, log, ...(boxed ? { box: { front: boxed.frontLogin() } } : {}) }
      ),
    givenLogin: (provider) => providers.givenLogin(provider),
    forgetAgent: (agentId) => {
      boxed?.forgetAgent(agentId);
      relay.unregister(agentId);
      hub.forget(agentId);
    },
    binaryPath: (provider) => providers.binaryPath(provider),
    now: deps.now,
    log,
    box: deps.box,
    ...boxed?.reconcileDeps(),
  };
  boxed?.startRest({ hub, client, reconcileDeps });

  /** Set while Switch refuses this controller because its owner is suspended. */
  let suspended = false;
  /**
   * Stops every agent, without forgetting any or touching a credential: the
   * assignment is held, and saved, with each agent stopped, so neither a
   * reconcile nor a restart starts one, and the next assignment pulled once
   * Switch lets the controller in again says how each should run.
   */
  const suspend = (message: string): void => {
    if (!suspended)
      log.error(
        'Switch refuses this controller because the account it belongs to is suspended: stopping every agent and asking again every so often. Its credential is kept, so it carries on by itself once the suspension is lifted.',
        { detail: message }
      );
    suspended = true;
    void queue.run(async () => {
      if (!assignment || stop.signal.aborted) return;
      if (assignment.agents.some((entry) => entry.desired_state !== 'stopped')) {
        assignment = allStopped(assignment);
        etag = null;
        store.saveAssignment(assignment, etag, new Date(deps.now()).toISOString());
      }
      try {
        await reconcile(assignment, reconcileDeps);
      } catch (error) {
        log.error('Could not stop the agents of a suspended account', {
          error: errorMessage(error),
        });
      }
    });
  };
  /** Switch let the controller in again: the next pull is a full one. */
  const unsuspend = (): void => {
    if (!suspended) return;
    suspended = false;
    etag = null;
    log.info('Switch lets this controller in again; pulling its assignment to start its agents.');
  };

  let syncQueued = false;
  const sync = (why: string): Promise<void> => {
    if (syncQueued) return Promise.resolve();
    syncQueued = true;
    return queue.run(async () => {
      syncQueued = false;
      if (stop.signal.aborted) return;
      try {
        const pulled = await (boxed
          ? client.assignment(etag).catch((error: unknown) => {
              boxed.fetchFailed();
              throw error;
            })
          : client.assignment(etag));
        boxed?.pulled(assignment, pulled.kind === 'changed' ? pulled.assignment : null);
        if (pulled.kind === 'changed') {
          // Still refused for anything else, so it keeps every agent stopped,
          // at the revision it already holds: stopping them at a revision
          // pulled meanwhile would record that revision as applied, and once
          // let in again the same revision would start nothing.
          assignment = suspended ? allStopped(assignment ?? pulled.assignment) : pulled.assignment;
          etag = suspended ? null : pulled.etag;
          store.saveAssignment(assignment, etag, new Date(deps.now()).toISOString());
          log.info('Pulled assignment', { revision: assignment.revision, why });
          placeAgents(assignment);
        }
        if (assignment)
          await (boxed
            ? reconcile(assignment, reconcileDeps, { fetched: true })
            : reconcile(assignment, reconcileDeps));
        reporter?.request();
      } catch (error) {
        failed('Assignment sync', error);
      }
    });
  };

  const takeUpLogin = async (provider: Provider) => {
    const status = await providers.check(provider, { verify: true });
    await reporter?.sendNow();
    void reconcileLocally();
    return { status, problem: providers.loginProblem(provider) };
  };

  let operationsQueued = false;
  const runOperations = (): Promise<void> => {
    if (operationsQueued) return Promise.resolve();
    operationsQueued = true;
    return queue.run(async () => {
      operationsQueued = false;
      if (stop.signal.aborted) return;
      try {
        const ran = await processPendingOperations({
          client,
          assignment: () => assignment,
          restartAgent: async (entry) => {
            const problem = definitionProblem(entry, offered);
            if (problem) return { reason: 'definition_invalid', detail: problem };
            // Asked for by its owner: started now, not on its next message.
            boxed?.restartAsked(entry.agent_id);
            return startAgent(
              {
                kind: 'start',
                agentId: entry.agent_id,
                entry,
                restart: true,
                replaceIdentity: false,
                clearTakenOver: true,
                relaunch: true,
                why: 'restart requested',
              },
              reconcileDeps
            );
          },
          recheckProvider: async (provider) => {
            // Asked for by someone fixing a login, like the Console recheck,
            // so the login is tried for real.
            const status = await providers.check(provider, { verify: true });
            await reporter?.sendNow();
            // Agents move onto a login given since, or off one withdrawn.
            void reconcileLocally();
            return status;
          },
          takeUpLogin,
          signInWithBrowser: async (operationId, provider) =>
            boxed?.browserSignInRefusal(provider) ??
            signInWithBrowser(operationId, provider, {
              client,
              keys,
              controllerId: identity.controllerId,
              binaryPath: (name) => providers.binaryPath(name),
              takeUpLogin: (name) => queue.run(() => takeUpLogin(name)),
              signal: stop.signal,
              timeoutMs: BROWSER_SIGN_IN_TIMEOUT_MS,
              progressEveryMs: BROWSER_SIGN_IN_PROGRESS_MS,
              log,
            }),
          restartController: () => {
            if (!deps.supervised)
              return {
                reason: 'not_supervised',
                detail:
                  'This controller runs outside a service, so ending it would only stop it. Restart it on the machine instead.',
              };
            restartRequested = true;
            return null;
          },
          log,
        });
        if (ran) reporter?.request();
        if (restartRequested) {
          log.info('Restarting, as asked through Switch');
          restartReason = 'requested';
          restart();
        }
      } catch (error) {
        failed('Running operations', error);
      }
    });
  };

  const idle = async () =>
    noSessionMidTurn(
      await Promise.all((assignment?.agents ?? []).map((entry) => runtime.observe(entry.agent_id)))
    );
  /** What the last status response named; looked at again while an update waits for idle. */
  let offeredRelease: unknown = null;
  const offerRelease = () => {
    if (deps.selfUpdate && !stop.signal.aborted)
      void deps.selfUpdate.offer(offeredRelease, { idle, restart, signal: stop.signal });
  };
  reporter = new StatusReporter({
    collect: async () => {
      const collected = await collector.collect(assignment);
      await boxed?.collected(collected);
      const update = deps.selfUpdate?.status();
      return update ? { ...collected, update } : collected;
    },
    send: async (report) => {
      const answer = await client.putStatus(report);
      reportWithinS = answer.report_within_s;
      if (assignment === null || answer.assignment_revision > assignment.revision)
        void sync('status says the assignment moved on');
      offeredRelease = answer.controller_release;
      offerRelease();
    },
    seq: () => store.nextStatusSeq(deps.now()),
    minGapMs: timing.statusMinGapMs,
    ...(boxed ? { box: { log } } : {}),
    failed: (error) => failed('Status report', error),
    onLocalChange: () => void reconcileLocally(),
  });

  const stopServingRechecks = deps.rechecks.serve(async () => {
    await deps.refreshPath();
    // A recheck is asked for by someone setting up or fixing a login, so
    // each login is tried for real, not only reported as there.
    await providers.checkAll({ verify: true });
    deps.log.info('Rechecked providers', {
      path: process.env.PATH,
      found: providers.locations(),
    });
    await reporter?.sendFresh();
    // Agents waiting on a provider can start now.
    void reconcileLocally();
    boxed?.retryUnchecked();
  });

  let localQueued = false;
  /**
   * Reconciles the assignment already held, without asking the server: at
   * startup, and whenever an agent's observed state changes, so an agent host
   * that died is dealt with now rather than at the next nudge or resync.
   */
  const reconcileLocally = (): Promise<void> => {
    if (localQueued) return Promise.resolve();
    localQueued = true;
    return queue.run(async () => {
      localQueued = false;
      if (!assignment || stop.signal.aborted) return;
      try {
        await reconcile(assignment, reconcileDeps);
      } catch (error) {
        failed('Reconciling the held assignment', error);
      }
    });
  };

  /** When each outdated agent host was last restarted onto this controller's bundle. */
  const outdatedRestarts = new Map<string, number>();
  let outdatedQueued = false;
  /**
   * Restarts each agent host that outlived this controller on another
   * shared-host bundle (`AgentObservation.outdated`) onto this controller's,
   * once none of its sessions is mid-turn: idle sessions restart with it and
   * resume their conversations. An agent host already restarted for it is
   * left for `OUTDATED_RESTART_RETRY_MS` before another try.
   */
  const restartOutdated = (): Promise<void> => {
    if (outdatedQueued) return Promise.resolve();
    outdatedQueued = true;
    return queue.run(async () => {
      outdatedQueued = false;
      if (!assignment || stop.signal.aborted) return;
      try {
        for (const entry of assignment.agents) {
          if (entry.desired_state !== 'running' || definitionProblem(entry, offered)) continue;
          const agentId = entry.agent_id;
          const observation = await runtime.observe(agentId);
          if (!observation.alive || !observation.outdated) continue;
          const last = outdatedRestarts.get(agentId);
          if (last !== undefined && deps.now() - last < OUTDATED_RESTART_RETRY_MS) continue;
          if (!noSessionMidTurn([observation])) continue;
          if (last !== undefined)
            log.error(
              'An agent host restarted onto this controller’s shared-host bundle is still on another (the restart failed, or it came back on another bundle); restarting it again',
              { agentId, restartedAt: new Date(last).toISOString() }
            );
          outdatedRestarts.set(agentId, deps.now());
          log.warn(
            'Restarting an agent host that outlived this controller on another shared-host bundle, now that none of its sessions is mid-turn',
            { agentId, version: deps.version }
          );
          await startAgent(
            {
              kind: 'start',
              agentId,
              entry,
              restart: true,
              replaceIdentity: false,
              clearTakenOver: false,
              relaunch: true,
              why: 'agent host on another shared-host bundle',
            },
            reconcileDeps
          );
        }
      } catch (error) {
        failed('Restarting outdated agent hosts', error);
      }
    });
  };

  /** A hint that a chat with the agent was created or reopened: a failure costs only the head start. */
  const warmAgent = async (agentId: string, roomId: string): Promise<void> => {
    if (boxed?.wokeForWarm(agentId)) return;
    try {
      await runtime.warm(agentId, roomId);
    } catch (error) {
      log.warn('Could not warm an agent’s session for a room; its first message starts it', {
        agentId,
        roomId,
        error: errorMessage(error),
      });
    }
  };

  const onFrame = async (frame: ControllerFrame): Promise<void> => {
    switch (frame.type) {
      case 'connection_state':
        reportWithinS = frame.data.report_within_s;
        if (assignment === null || frame.data.assignment_revision > assignment.revision)
          void sync('the stream says the assignment moved on');
        return;
      case 'evicted':
        return;
      case 'agent.event':
        hub.ingest(frame.data);
        return;
      case 'agent.gap':
        log.warn('Switch reports events an agent missed', {
          agentId: frame.data.agent_id,
          reason: frame.data.reason,
        });
        hub.gap(frame.data);
        return;
      case 'agent.session_command':
        hub.sessionCommand(frame.data);
        return;
      case 'agent.warm':
        void warmAgent(frame.data.agent_id, frame.data.room_id);
        return;
      case 'agent.approval_outcome':
        hub.approvalOutcome(frame.data);
        return;
      case 'agent.attached':
        hub.attach(frame.data.agent_id, frame.data.from_seq, frame.data.rooms);
        return;
      case 'agent.detached':
        hub.detach(frame.data.agent_id, frame.data.reason);
        return;
      case 'agent.rooms':
        hub.setRooms(frame.data.agent_id, frame.data.rooms);
        return;
      case 'assignment.changed':
        void sync(`assignment.changed to revision ${frame.data.revision}`);
        return;
      case 'operation.pending':
        void runOperations();
        return;
      case 'credential.revoked':
        await revoke();
        return;
    }
  };

  if (boxed) {
    await boxed.startLauncherLink();
    // After `placeAgents` gave the hub its cursors, before anything is started.
    boxed.beforeFirstReconcile();
  }
  await reconcileLocally();
  relay.setReady();
  boxed?.ready();

  if (boxed)
    void providers
      .refreshStale()
      .catch((error: unknown) => failed('Checking providers', error))
      .then(() => boxed.retryUnchecked());
  else void providers.refreshStale().catch((error: unknown) => failed('Checking providers', error));

  const resync = setInterval(() => {
    void sync('periodic resync');
    void runOperations();
    void providers.refreshStale().catch((error: unknown) => failed('Checking providers', error));
  }, timing.resyncMs);
  let lastPeriodic = deps.now();
  const poll = setInterval(() => {
    if (deps.now() - lastPeriodic >= reportWithinS * 1000) {
      lastPeriodic = deps.now();
      reporter?.request();
      return;
    }
    void reporter?.requestIfChanged();
    // A turn ending changes nothing reported, so it would otherwise wait for
    // the next periodic report to let the update through.
    if (deps.selfUpdate?.status()?.state === 'waiting_idle') offerRelease();
    void restartOutdated();
    boxed?.poll();
  }, timing.statusPollMs);

  let ending: ControllerExit = 'stopped';
  try {
    ending = await runControllerStream({
      client,
      cursors: () => {
        const cursors: Record<string, AgentCursor> = {};
        for (const entry of assignment?.agents ?? []) cursors[entry.agent_id] = 'head';
        return { ...cursors, ...hub.cursors() };
      },
      confirmed: () => hub.cursors(),
      onOpened: (connection) =>
        log.info('Switch has these agents bound to this controller', {
          agents: connection.agents,
        }),
      onConnected: () => {
        log.info('Connected to Switch');
        unsuspend();
        hub.streamAttached();
        void sync('connected');
        void runOperations();
      },
      onDisconnected: () => {
        hub.setUpstream(false);
      },
      onFrame,
      signal: stop.signal,
      log,
      idleTimeoutMs: timing.streamIdleMs,
      initialBackoffMs: timing.streamInitialBackoffMs,
      maxBackoffMs: timing.streamMaxBackoffMs,
      suspendedRetryMs: timing.streamSuspendedRetryMs,
      onSuspended: suspend,
      random: deps.random,
      calls,
    });
    if (ending === 'revoked') await revoke();
    if (ending === 'taken_over')
      log.error(
        'Another instance of this controller took over its connection to Switch; this one stops its agents and exits.'
      );
    if (ending === 'upgrade_required' || ending === 'credential_invalid') refused ??= ending;
    if (refused === 'upgrade_required')
      log.error(
        'Switch does not speak this controller’s protocol; it stops its agents and exits. Update the controller.'
      );
    if (refused === 'credential_invalid')
      log.error(
        'Switch knows no controller by this credential; it stops its agents and exits. Enroll this machine again.'
      );
    if (restarting && !refused && !revocation)
      log.info(
        restartReason === 'update'
          ? 'Exiting for the service to start this controller on its new release.'
          : 'Exiting for whatever runs this controller to start it again.'
      );
  } finally {
    stopServingRechecks();
    boxed?.stopping();
    clearInterval(resync);
    clearInterval(poll);
    signal.removeEventListener('abort', forward);
    stop.abort();
    try {
      if (revocation) await revocation;
      await queue.drain();
      await reporter.idle();
      await deps.selfUpdate?.settled();
    } finally {
      await runtime.close();
      await relay.close();
      await boxed?.close();
    }
  }
  if (revocation) return 'revoked';
  return refused ?? (restarting ? 'restarting' : ending);
}

/**
 * Sends status reports: on request, coalescing bursts so that at most one goes
 * out per `minGapMs`, and only one is in flight at a time.
 */
class StatusReporter {
  private lastSentFingerprint: string | null = null;
  private lastObservedFingerprint: string | null = null;
  private lastSentAt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> | null = null;
  private again = false;
  private closed = false;
  /** Box mode only: where each agent's sessions stood in the last report Switch took. */
  private lastSentSessions: SessionsSent | null = null;
  /** Box mode only: a check passed over because a report was on its way, since the last one sent. */
  private skippedAt: number | null = null;

  constructor(
    private readonly deps: {
      collect: () => Promise<Omit<StatusReport, 'seq'>>;
      send: (report: StatusReport) => Promise<void>;
      seq: () => number;
      minGapMs: number;
      /**
       * Box mode only: a session waking or parking alone sends a report but is
       * no reason to reconcile, and each agent whose sessions a report moved is
       * logged with how long that took.
       */
      box?: { log: Logger };
      failed: (error: unknown) => void;
      /** Something observed locally differs from the last look. */
      onLocalChange: () => void;
    }
  ) {}

  request(): void {
    if (this.closed) return;
    if (this.inFlight) {
      this.again = true;
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastSentAt + this.deps.minGapMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.sendNow();
    }, wait);
  }

  async requestIfChanged(): Promise<void> {
    if (this.inFlight && this.deps.box) {
      // Not looked at: a change seen now waits for the next check.
      this.skippedAt ??= Date.now();
      return;
    }
    if (this.inFlight || this.timer) return;
    try {
      const collected = await this.deps.collect();
      const fingerprint = statusFingerprint(collected);
      if (this.lastObservedFingerprint !== null && fingerprint !== this.lastObservedFingerprint)
        this.deps.onLocalChange();
      this.lastObservedFingerprint = fingerprint;
      if (this.sentFingerprint(collected) !== this.lastSentFingerprint) this.request();
    } catch (error) {
      this.deps.failed(error);
    }
  }

  sendNow(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    this.inFlight = (async () => {
      try {
        const checkedAt = Date.now();
        const collected = await this.deps.collect();
        const report = statusReportSchema.parse({ ...collected, seq: this.deps.seq() });
        this.lastSentAt = Date.now();
        await this.deps.send(report);
        this.lastSentFingerprint = this.sentFingerprint(collected);
        this.sent(report, checkedAt);
      } catch (error) {
        this.deps.failed(error);
      }
    })().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.request();
      }
    });
    return this.inFlight;
  }

  /**
   * Sends a report collected after this call, once any already on its way has
   * gone, and fails when it could not be sent: for a caller that must know
   * Switch holds what is true now.
   */
  async sendFresh(): Promise<void> {
    while (this.inFlight) await this.inFlight;
    if (this.closed) throw new Error('The controller is stopping.');
    let failure: unknown = null;
    this.inFlight = (async () => {
      try {
        const checkedAt = Date.now();
        const collected = await this.deps.collect();
        const report = statusReportSchema.parse({ ...collected, seq: this.deps.seq() });
        this.lastSentAt = Date.now();
        await this.deps.send(report);
        this.lastSentFingerprint = this.sentFingerprint(collected);
        this.sent(report, checkedAt);
      } catch (error) {
        failure = error;
      }
    })().finally(() => {
      this.inFlight = null;
      if (this.again) {
        this.again = false;
        this.request();
      }
    });
    await this.inFlight;
    if (failure !== null) throw failure;
  }

  /** What decides whether a report differs from the last one sent. */
  private sentFingerprint(collected: Omit<StatusReport, 'seq'>): string {
    return this.deps.box ? reportFingerprint(collected) : statusFingerprint(collected);
  }

  /** Box mode only: logs each agent whose sessions this report moved, and how long that took. */
  private sent(report: StatusReport, checkedAt: number): void {
    if (!this.deps.box) return;
    for (const entry of sessionChangeEntries(this.lastSentSessions, report, {
      checkedAt,
      sentAt: Date.now(),
      skippedAt: this.skippedAt,
    }))
      this.deps.box.log.info(entry.message, entry.fields);
    this.lastSentSessions = sessionsSent(report);
    this.skippedAt = null;
  }

  /** Stops sending, and waits for a report already on its way. */
  async idle(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    await this.inFlight;
  }
}
