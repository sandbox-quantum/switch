import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  BoxValve,
  type ValveEvent,
  boxCap,
  boxLimitFromEnv,
  CAP_HEADROOM,
  CONTROLLER_RESTING_BYTES,
  type OpenAgentStream,
  type ProviderReadiness,
  type RestartNotice,
  SESSION_ALLOWANCE_BYTES,
  startReserveFromEnv,
} from '@switch-console/agent-providers-box';
import { AgentHub } from './agent-hub';
import { LeftoverWatch } from './agent-removal';
import { AgentsDisk } from './agents-disk';
import {
  AccessTokens,
  ControllerClient,
  type Fetch,
  isCredentialRefused,
  isRevoked,
  isUpgradeRequired,
  type OpenWebSocket,
} from './api';
import { valveLimits } from './controller-reserve';
import { ConfigurationError } from './errors';
import { topLevelLabels } from './file-labels';
import type { FilesReply } from './files-frames';
import { FilesRelay } from './files-relay';
import {
  type GatewayDeps,
  gatewayEnvironment,
  gatewayProbe,
  resolveGateway,
} from './gateway-agents';
import { gatewayPlanFor, VertexTokenCache } from './gateway-logins';
import { DailyCallCap, dailyCalls, usageFile } from './gateway-usage';
import type { HostTickets } from './host-tickets';
import { HubSocket } from './hub-socket';
import type { LauncherGuard } from './launcher-guard';
import type { LauncherLink, LinkState } from './launcher-link';
import type { LauncherRunner } from './launcher-runner';
import { LiveEvents, teeLogger } from './live-events';
import { gatherLiveExtras, LiveStatusWriter } from './live-status';
import { errorCode, errorMessage, type Logger } from './log';
import type { LoginCheck } from './login-check';
import {
  GuardStatus,
  type GuardLimits,
  hostAnnouncer,
  hostPidsFromRoot,
  MemoryGuard,
  readBoxMemory,
} from './memory-guard';
import { MemorySourceCheck } from './memory-source-check';
import { processPendingOperations } from './operations';
import type { OwnerMarkers } from './owner-marker';
import { dataLayout, isSafeSegment } from './paths';
import { connectionIsHost } from './peer-check';
import { ProviderGateway } from './provider-gateway';
import type { ProviderRechecks } from './provider-rechecks';
import {
  CREDENTIAL_RESTART_WAIT_MS,
  type CredentialChange,
  CredentialRestarts,
  definitionProblem,
  reconcile,
  type ReconcileDeps,
  startAgent,
} from './reconcile';
import { LocalRelay, RELAY_TOKEN_PREFIX } from './relay';
import { UpstreamForwarder } from './relay-forward';
import { AgentRest, type SweepResult } from './rest';
import type { AgentRuntime, GatewayRecord } from './runtime';
import {
  type AgentAssignment,
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
import { readSplitBoxMemory } from './split-memory';
import type { LaunchGate, ProbeEnv } from './split-runtime';
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
import { type ControllerFrame, type FilesChannel, runControllerStream } from './stream';

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
  /** The most events held per agent while its agent host is not taking them. */
  eventBufferLimit: number;
  /** Split mode: the wait before trying the launcher listener's address again (`LAUNCHER_LISTEN_RETRY_MS`). */
  launcherListenRetryMs?: number;
  /** The waits before each new try of a given login whose sign-in check could not run (`UNCHECKED_RETRY_MS`). */
  uncheckedRetryMs?: readonly number[];
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
  eventBufferLimit: 5_000,
};

/**
 * How long an agent host restarted onto this controller's shared-host bundle
 * is left before it is restarted again, when the restart failed or it still
 * runs another bundle.
 */
export const OUTDATED_RESTART_RETRY_MS = 10 * 60 * 1000;
/** Split mode: how often a controller that couldn't listen for the launcher tries the same address again. */
export const LAUNCHER_LISTEN_RETRY_MS = 10_000;

export type ControllerDeps = {
  store: ControllerStore;
  /**
   * How long an agent's sessions must all be parked before its agent host is
   * stopped until its next message; null or absent, agents never rest.
   */
  restAfterMs?: number | null;
  /**
   * Where to write the live status (`status --live`) every few seconds:
   * counts and states only. Null or absent, it is not written.
   */
  liveStatusDir?: string | null;
  /** The box image's digest, for the live status (`SWITCH_IMAGE_DIGEST`); null when unknown. */
  imageDigest?: string | null;
  /**
   * Bytes kept back for the controller under the box's memory limit
   * (`controllerReserveFromEnv`): the box valve's memory lines work to the
   * limit less this, while its cap stays on the whole limit. 0 or absent, none.
   */
  controllerReserve?: number;
  /**
   * Front given logins through the provider gateway: the agents'
   * CLIs get a local base URL and an opaque token, never the login. Off by
   * default.
   */
  providerGateway?: boolean;
  /**
   * With the gateway: the box's daily cap on provider calls, as the setting
   * gives it (`gateway-usage.ts`). Unset, empty or 0, none; anything but a
   * whole number stops the controller.
   */
  providerGatewayDailyCalls?: string;
  /**
   * Ends what a stopped agent left running, with proof it is the agent's (the
   * ownership marker); absent, nothing is swept.
   */
  sweepAgent?: (agentId: string) => Promise<SweepResult>;
  /**
   * The per-agent memory guard: the owner markers that prove whose a process
   * is, and the limits it judges by. Absent (no markers, or no box memory
   * limit set, as on a laptop), nothing is measured or stopped.
   */
  memoryGuard?: { markers: OwnerMarkers; limits: GuardLimits };
  /**
   * On a split box, the controller runs as its own user: every agent host runs in the
   * agents container through the launcher. The controller listens on `link`,
   * mints a one-time ticket for every host hello, and measures and stops
   * through the launcher (`guard`). Silence means stop: while the launcher is
   * quiet nothing is admitted and idle sessions park; while lost, nothing starts.
   */
  split?: {
    link: LauncherLink;
    tickets: HostTickets;
    guard: LauncherGuard;
    runner: Pick<LauncherRunner, 'launchOf' | 'currentLaunch'>;
    gate: LaunchGate;
    /** Given the gateway's probe once it is up, so a login's sign-in check goes through it. */
    setProbeEnv?: (probeEnv: ProbeEnv | undefined) => void;
    /**
     * Test boxes only (the template marks the box; `main` refuses it
     * otherwise): an operator's exec into the agents container is left
     * running and counted, not ended as a stranger. Shown in status.
     */
    operatorExec?: boolean;
  };
  secrets: SecretStore;
  /**
   * Builds how agents run here, given the stream each agent's agent host hears
   * its events on and the folder agents with no directory of their own work in.
   */
  runtime: (
    openStream: (agentId: string) => OpenAgentStream,
    workspaces: string,
    /** Posts an agent's restart line through this controller, keyed by its turn. */
    restartNotice?: (agentId: string) => RestartNotice
  ) => AgentRuntime;
  /** Tries a provider's own login with a test prompt; absent where agents run as other users. */
  verifyLogin?: (provider: Provider, binaryPath: string) => Promise<ProviderReadiness> | null;
  /**
   * A login given to the machine, checked with its provider once the CLI signs
   * in with it: a Vertex AI login asks Google for a token (`login-check.ts`).
   * Absent: the CLI's sign-in check is the whole check.
   */
  checkGivenLogin?: LoginCheck;
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
  /** Who moves it onto another release, as its status reports to Switch. */
  updatedBy: UpdatedBy;
  /**
   * Follows the release Switch names for this controller; null where Switch
   * Console updates it instead.
   */
  selfUpdate: SelfUpdater | null;
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
/**
 * Whether the provider gateway can front a given login. One it can't even read
 * (a malformed Vertex AI login) counts as frontable here, so the usual sign-in
 * check meets it and says what is wrong, as before.
 */
export function frontable(login: GivenLogin, gateway: Pick<GatewayDeps, 'vertex'>): boolean {
  try {
    return gatewayPlanFor(login, gateway.vertex) !== null;
  } catch {
    return true;
  }
}

function sameLogin(a: GivenLogin | null, b: GivenLogin | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.provider === b.provider &&
    a.revision === b.revision &&
    a.kind === b.kind &&
    a.credential === b.credential
  );
}

/** When a given login whose sign-in check could not run is tried again: four tries, backing off. */
export const UNCHECKED_RETRY_MS = [15_000, 30_000, 60_000, 120_000] as const;

export async function ensureRelayCredentials(
  agentId: string,
  providerLogin: GivenLogin | null,
  deps: { runtime: AgentRuntime; relay: LocalRelay; log: Logger; gateway?: GatewayDeps | null }
): Promise<CredentialChange> {
  const current = await deps.runtime.readCredentials(agentId);
  const endpoint = deps.relay.endpoint;
  const hub = deps.relay.hubUrl;
  const relayCurrent =
    current !== null &&
    current.endpoint === endpoint &&
    current.hub === hub &&
    current.token.startsWith(RELAY_TOKEN_PREFIX);
  // With a provider gateway, a login it fronts is never written to the file:
  // only the agent's opaque gateway token is.
  const fronted = deps.gateway
    ? resolveGateway(agentId, providerLogin, current?.gateway ?? null, deps.gateway)
    : { fileLogin: providerLogin, record: null };
  const fileLogin = fronted.fileLogin;
  const record = fronted.record;
  if ('refused' in fronted && fronted.refused && providerLogin && deps.gateway) {
    const key = `${agentId}:${providerLogin.provider}:${providerLogin.revision}`;
    const said = (deps.gateway.refusedSaid ??= new Set());
    if (!said.has(key)) {
      said.add(key);
      deps.log.warn('A given login is not used: the provider gateway cannot front it', {
        agentId,
        provider: providerLogin.provider,
        kind: providerLogin.kind,
      });
    }
  }
  const loginCurrent =
    sameLogin(current?.providerLogin ?? null, fileLogin) &&
    sameRecord(current?.gateway ?? null, record);
  if (current && relayCurrent && loginCurrent) {
    if (!deps.relay.isRegistered(agentId, current.token))
      deps.relay.register(agentId, current.token);
    return false;
  }
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
  // A login withdrawn must not stay in use while a turn finishes: only a
  // login given or changed waits for the turn. A login swapped inside
  // the gateway changes nothing the running host reads.
  const change: CredentialChange = !(current && relayCurrent)
    ? 'relay'
    : fronted.change !== undefined
      ? fronted.change
      : fileLogin
        ? 'login'
        : 'withdrawn';
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
  return change;
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
 * What the box valve calls while it sheds: the memory guard's pause on its
 * slow-leak clock, if there is a guard. Read through `guard` on each call,
 * since the guard is made after the valve.
 */
export function valveSheddingHook(
  guard: () => Pick<MemoryGuard, 'valveShedding'> | null
): (shedding: boolean) => void {
  return (shedding) => guard()?.valveShedding(shedding);
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
 * wipes the credential and ends the loop with `'revoked'`. A later start whose
 * credential that revoke wiped ends with `'revoked'` straight away. A full resync runs
 * every ten minutes regardless. Status goes out when something changes, and
 * at least every `report_within_s`.
 *
 * Before any of that, the cached assignment is reconciled, so agents come back
 * after a reboot even while the server is unreachable.
 */
export async function runController(
  deps: ControllerDeps,
  signal: AbortSignal
): Promise<ControllerExit> {
  const { store, timing } = deps;
  /** The fixed log events the live status counts (`--since`); only when it is written. */
  const liveEvents = deps.liveStatusDir ? new LiveEvents(deps.now) : null;
  const log = liveEvents ? teeLogger(deps.log, liveEvents) : deps.log;
  let dailyCallCap = 0;
  if (deps.providerGateway) {
    try {
      dailyCallCap = dailyCalls(deps.providerGatewayDailyCalls);
    } catch (error) {
      throw new ConfigurationError(errorMessage(error));
    }
  }
  const identity = store.identity();
  if (!identity)
    throw new ConfigurationError(
      `This controller is not enrolled: ${deps.dataDir} holds no identity. Run 'switch-agent-controller enroll --server <url> --code <code>' first.`
    );
  const credential = await deps.secrets.get(CONTROLLER_CREDENTIAL);
  if (!credential) {
    const revokedAt = store.revokedAt();
    if (revokedAt) {
      // An earlier run was revoked and wiped the credential (a box started
      // again after a pause and resume). End as revoked, exit 3, as that
      // run did: the box's entrypoint then keeps this identity aside and enrols
      // afresh with the code in its Secret, if Switch gave it one.
      log.warn(
        'This controller was revoked earlier and its credential wiped; it needs enrolling again with a new code',
        { controllerId: identity.controllerId, revokedAt }
      );
      return 'revoked';
    }
    throw new ConfigurationError(
      `The controller credential is missing from ${deps.secrets.description}. Enroll again with a new code.`
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
  /** When the assignment was last pulled from Core, for the live status. */
  let lastSyncAt: number | null = null;
  let etag: string | null = cached.kind === 'saved' ? cached.etag : null;
  let reportWithinS = timing.defaultReportWithinS;
  let revocation: Promise<void> | null = null;
  let reporter: StatusReporter | null = null;

  let rest: AgentRest | null = null;
  const hub = new AgentHub({
    log,
    bufferLimit: timing.eventBufferLimit,
    onCursor: (agentId, cursor) =>
      store.saveCursor(agentId, cursor, new Date(deps.now()).toISOString()),
    onChange: () => reporter?.request(),
    onWake: (agentId, why) => rest?.wake(agentId, why),
    onAddressedTaken: (agentId, event) => rest?.addressedTaken(agentId, event),
    now: deps.now,
    resetRefused: (agentId, notice) => client.resetRefused(agentId, notice),
    // A reset kept for a resting agent that will not reach a host after all
    // gets the "couldn't reset" line, like one with no host or session.
    onHeldCommandDropped: (agentId, roomId, command) => hub.refuseReset(agentId, roomId, command),
  });
  /**
   * The box valve: one for the box, owned here. Every agent host asks
   * it before it starts a session: an isolated one over the hub, once proved
   * to be the agent's own host process, and one in this process directly.
   * Off without a box limit, as on a laptop.
   */
  const split = deps.split;
  // Split mode only: true while the controller can't listen for the launcher (fail closed).
  let launcherUnavailable = false;
  /** A restarted agents container not yet looked at afresh: no admits until it has. */
  let splitSettling = false;
  /**
   * Ends an agent's current host and reconciles again once `afterMs` has
   * passed, so it is started afresh with a new ticket (split boxes only).
   * The gate refuses the start until its backoff is over.
   */
  const relaunchSplitHost = (agentId: string, afterMs: number): void => {
    log.warn('Starting an agent’s host again', { agentId, afterMs });
    void runtime
      .stop(agentId, { wait: true, asked: false })
      .catch(() => {})
      .finally(() => {
        const timer = setTimeout(() => void reconcileLocally(), afterMs + 50);
        timer.unref?.();
      });
  };
  const valveLog = {
    info: (line: string) => log.info(line),
    warn: (line: string) => log.warn(line),
  };
  const boxLimit = boxLimitFromEnv(process.env, valveLog);
  // The cap stays on the box's whole limit (it already allows for the
  // controller at rest); only the memory lines move down by the reserve.
  const reserve = boxLimit === null ? 0 : (deps.controllerReserve ?? 0);
  const limits = valveLimits(boxLimit, reserve);
  // Split boxes: the reading must see the whole pod (meminfo, not the cgroup).
  const sourceCheck = new MemorySourceCheck({
    split: split !== undefined,
    launcherTotal: () => split?.guard.totalBytes() ?? null,
    log,
  });
  const cap = limits === null ? null : boxCap(limits.capLimit, process.env, valveLog);
  const boxValve = new BoxValve({
    limit: limits === null ? null : limits.lineLimit,
    // The guard's scale, so the valve's 80% and 90% and the guard's 92% are one measure.
    readUsage: async () => {
      // A split box reads /proc/meminfo only: its cgroup is the controller's own container.
      const reading = await (split ? readSplitBoxMemory() : readBoxMemory());
      sourceCheck.observe(reading);
      // On a split box a cgroup-only reading is no reading: the valve fails closed.
      return sourceCheck.usable(reading);
    },
    ...(cap ? { cap: cap.cap } : {}),
    ...(boxLimit === null ? {} : { startReserve: startReserveFromEnv(process.env, valveLog) }),
    // An agent the guard is stopping or holding is left alone: not parked, counted or admitted.
    isHeld: (agentId) => {
      const kind = rest?.state(agentId)?.kind;
      return kind === 'out_of_memory' || kind === 'resting';
    },
    // The guard pauses only its slow-leak clock while the valve sheds (`MemoryGuard.valveShedding`).
    onShedding: valveSheddingHook(() => memoryGuard),
    // Wait-list changes, counted for the live status only when it is on.
    ...(liveEvents ? { onEvent: (event: ValveEvent) => liveEvents.noteValve(event) } : {}),
    // Split boxes: nothing starts while the launcher can't measure, or before a
    // restarted agents container has been looked at afresh.
    ...(split ? { admitting: () => split.link.current === 'live' && !splitSettling } : {}),
    log: valveLog,
  });
  if (cap && boxLimit !== null)
    log.info('Box valve on', {
      limitBytes: boxLimit,
      reserveBytes: reserve,
      restingBytes: CONTROLLER_RESTING_BYTES,
      headroomPercent: Math.round(CAP_HEADROOM * 100),
      sessionAllowanceBytes: SESSION_ALLOWANCE_BYTES,
      envBound: cap.bound,
      formula: cap.formula,
      cap: cap.cap,
    });
  /** Hosts join the valve only once the guard's holds are restored. */
  let openValve: () => void = () => {};
  const valveReady = new Promise<void>((resolve) => {
    openValve = resolve;
  });
  /** This agent's share of the cap while its hub is down: the cap over the agents running, at least 1. */
  const valveShare = () => {
    const running = (assignment?.agents ?? []).filter((entry) => entry.desired_state === 'running');
    return Number.isFinite(boxValve.cap)
      ? Math.max(1, Math.floor(boxValve.cap / Math.max(1, running.length)))
      : 1;
  };
  const workspaces = deps.workspacesFor(identity.server);
  const runtime = deps.runtime(
    (agentId) =>
      Object.assign((streamDeps: Parameters<OpenAgentStream>[0]) => hub.open(agentId, streamDeps), {
        boxValve,
      }),
    workspaces,
    (agentId) => (notice) => client.restartNotice(agentId, notice)
  );
  /** The hub over a WebSocket, kept for the status's joined-hosts count. */
  let hubSocket: HubSocket | null = null;
  // The agents' operations go to Switch on the controller's socket while it takes them.
  const calls = new SocketCalls();
  const relay = new LocalRelay({
    log,
    roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
    hub: (hubSocket = new HubSocket({
      hub,
      log,
      valve: {
        valve: boxValve,
        ready: valveReady,
        // Proved from /proc by the owner markers; with none (no guard), nothing is proved.
        trusted: async (agentId, peerPort, localPort) =>
          deps.memoryGuard
            ? connectionIsHost(
                agentId,
                layout.watcherRoot(agentId),
                peerPort,
                localPort,
                deps.memoryGuard.markers
              )
            : false,
        share: valveShare,
      },
      tickets: split?.tickets,
      currentLaunch: split ? (agentId) => split.runner.currentLaunch(agentId) : undefined,
      onTicketTaken: split ? (agentId) => split.gate.taken(agentId) : undefined,
      // Only a minted ticket refused as spent or another
      // agent's counts towards failure; anything else is a relaunch after a backoff.
      onTicketRefused: split
        ? (agentId, reason) => {
            if (split.runner.currentLaunch(agentId) === null) return; // nothing of ours to relaunch
            if (reason === 'spent' || reason === 'wrong_agent') {
              const burnt = split.gate.burn(agentId);
              if (burnt === 'failed') {
                log.error(
                  'An agent’s launch tickets kept being refused: it is failed until changed',
                  {
                    agentId,
                  }
                );
                void runtime.stop(agentId, { wait: false, asked: false }).catch(() => {});
                reporter?.request();
                return;
              }
              relaunchSplitHost(agentId, burnt);
              return;
            }
            relaunchSplitHost(agentId, split.gate.delay(agentId));
          }
        : undefined,
      // A living host whose hub dropped needs a fresh ticket to reconnect: only the controller mints one.
      onTicketedClosed: split
        ? (agentId) => {
            const launchId = split.runner.launchOf(agentId);
            if (launchId === null || split.link.current === 'lost') return;
            const ticket = split.tickets.mint(agentId, launchId);
            void split.link.order({ kind: 'ticket', agentId, launchId, ticket }).then((reply) => {
              if (!reply.ok) {
                split.tickets.forget(agentId);
                log.warn('Could not send an agent host a fresh hub ticket', {
                  agentId,
                  code: reply.code ?? 'failed',
                });
              }
            });
          }
        : undefined,
    })),
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
  const placeAgents = (held: Assignment): AgentAssignment[] => {
    const cursors = store.cursors();
    const fresh: AgentAssignment[] = [];
    for (const entry of held.agents) {
      const agentId = entry.agent_id;
      if (placed.has(agentId)) continue;
      placed.add(agentId);
      fresh.push(entry);
      const cursor = cursors.get(agentId);
      // Core may have attached the agent before the assignment that names it
      // was read: where it attached it is then where the hub already stands.
      if (cursor !== undefined && !hub.attachment(agentId)) hub.setCursor(agentId, cursor);
    }
    return fresh;
  };
  const layout = dataLayout(deps.dataDir);
  /** The memory guard's stops, for the report; it holds an agent until its next message wakes it. */
  const guardStatus = new GuardStatus({
    agentDir: (agentId) => layout.agentDir(agentId),
    stillHeld: (agentId) => rest?.state(agentId)?.kind === 'out_of_memory',
  });
  let memoryGuard: MemoryGuard | null = null;
  /** Agents placed whose guard holds (if any) are not yet restored: done before they can start. */
  let unrestored: AgentAssignment[] = assignment ? placeAgents(assignment) : [];
  const port = await relay.start(store.relayPort());
  store.saveRelayPort(port);
  log.info('Relay listening for this machine’s agents', { endpoint: relay.endpoint });
  let gateway: GatewayDeps | null = null;
  let dailyCap: DailyCallCap | null = null;
  if (deps.providerGateway) {
    if (dailyCallCap > 0)
      dailyCap = new DailyCallCap({
        cap: dailyCallCap,
        file: usageFile(join(deps.dataDir, 'gateway-usage.json')),
        log,
        now: deps.now,
      });
    gateway = {
      gateway: new ProviderGateway({ log, ...(dailyCap ? { cap: dailyCap } : {}) }),
      vertex: new VertexTokenCache(),
    };
    await gateway.gateway.start();
    log.info('Provider gateway listening for this machine’s agents', {
      endpoint: gateway.gateway.endpoint,
    });
  }
  // Split boxes: a given login's sign-in check runs in the agents container
  // with a short-lived gateway probe token, never the login.
  if (split && gateway) {
    const fronting = gateway;
    split.setProbeEnv?.(async (_provider, login) => gatewayProbe(randomUUID(), login, fronting));
  }

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
  const restart = () => {
    restarting = true;
    stop.abort();
  };

  const failed = (what: string, error: unknown) => {
    if (isRevoked(error)) {
      void revoke();
      return;
    }
    if (isUpgradeRequired(error)) return refuse('upgrade_required');
    if (isCredentialRefused(error)) return refuse('credential_invalid');
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
  // With the provider gateway on, only a login it can front is used: any other
  // is refused when given, saying so (rather than as a check that did not run).
  const loginGateway = gateway;
  const providers = new ProviderStatuses({
    locator: deps.locator,
    runtime,
    sealed,
    ...(loginGateway ? { usable: (login: GivenLogin) => frontable(login, loginGateway) } : {}),
    probeCwd: deps.dataDir,
    verify: deps.verifyLogin,
    checkLogin: deps.checkGivenLogin,
    now: deps.now,
    log,
    onChange: () => reporter?.request(),
  });
  providers.seed(deps.providerSeed);
  // Split boxes: the agents' volume is the box's disk, and only the launcher mounts it.
  const agentsDisk = split
    ? new AgentsDisk({ ask: () => split.link.order({ kind: 'disk' }), now: deps.now })
    : null;
  const collector = new StatusCollector({
    store,
    runtime,
    providers,
    tools: deps.tools,
    attached: (agentId) => hub.attached(agentId),
    rest: (agentId) => rest?.state(agentId) ?? null,
    streamCarries: (agentId) => hub.streamCarries(agentId),
    guard: {
      held: (agentId) => guardStatus.held(agentId),
      oomKills: (agentId) => guardStatus.oomKills(agentId),
      boxNote: () => memoryGuard?.boxNote() ?? null,
    },
    onAgentAwake: (agentId, awake) => boxValve.noteHealth(agentId, awake),
    onAgentsSeen: (agentIds) => boxValve.keepHealthOnly(agentIds),
    sessionsMax: () => (Number.isFinite(boxValve.cap) ? boxValve.cap : 0),
    valveHosts: () => (boxValve.enabled ? (hubSocket?.valveHosts() ?? null) : null),
    // No launcher listener means no host can start, and nothing is guarded: reported as such.
    valveMemory: () =>
      launcherUnavailable ? 'unprotected' : (boxValve.memoryProblem ?? sourceCheck.problem),
    boxCounts: () => ({
      guardStops: memoryGuard ? guardStatus.stops() : null,
      valveParks: boxValve.enabled ? boxValve.parks : null,
    }),
    gatewayCounts: () =>
      gateway ? { ...gateway.gateway.counts(), ...(dailyCap ? dailyCap.counts() : {}) } : null,
    operatorExec: split?.operatorExec === true,
    dataDir: deps.dataDir,
    ...(agentsDisk ? { disk: () => agentsDisk.reading() } : {}),
    workspacesDir: workspaces,
    version: deps.version,
    updatedBy: deps.updatedBy,
    now: deps.now,
  });
  const credentialRestarts = new CredentialRestarts();
  const reconcileDeps: ReconcileDeps = {
    store,
    runtime,
    credentialRestarts,
    ensureCredentials: async (agentId, provider) =>
      ensureRelayCredentials(
        agentId,
        isProvider(provider) ? await providers.givenLogin(provider) : null,
        { runtime, relay, log, gateway }
      ),
    givenLogin: (provider) => providers.givenLogin(provider),
    ...(gateway
      ? {
          gatewayEnv: async (agentId: string, login: GivenLogin) =>
            gatewayEnvironment(login, (await runtime.readCredentials(agentId))?.gateway, gateway),
        }
      : {}),
    forgetAgent: (agentId) => {
      gateway?.gateway.forget(agentId);
      relay.unregister(agentId);
      hub.forget(agentId);
    },
    binaryPath: (provider) => providers.binaryPath(provider),
    removal: { layout: dataLayout(deps.dataDir), log, leftovers: new LeftoverWatch() },
    now: deps.now,
    log,
    rest: {
      suspended: (agentId) => rest?.suspended(agentId) ?? false,
      clear: (agentId) => rest?.clear(agentId),
    },
  };
  rest = new AgentRest({
    hub,
    observe: (agentId) => runtime.observe(agentId),
    stopHost: (agentId) => runtime.stop(agentId, { wait: true }),
    sweep: deps.sweepAgent ?? (async () => ({ signalled: 0, killed: 0, gone: 0, notProven: 0 })),
    start: async (agentId) => {
      const entry = assignment?.agents.find((candidate) => candidate.agent_id === agentId);
      if (!entry || entry.desired_state !== 'running' || definitionProblem(entry)) return null;
      return startAgent(
        {
          kind: 'start',
          agentId,
          entry,
          restart: false,
          replaceIdentity: false,
          clearTakenOver: false,
          // Not a restart: a wake is not counted in `restarts_10m`.
          relaunch: false,
          why: 'a message for an agent whose host was stopped until its next message',
        },
        reconcileDeps
      );
    },
    run: (task) => queue.run(task),
    restAfterMs: deps.restAfterMs ?? null,
    now: deps.now,
    log,
    onChange: () => reporter?.request(),
    restNotice: (agentId, notice) => client.restNotice(agentId, notice),
    // The wake ends a guard stop: released on disk at once, so a restart does
    // not hold the agent again for a message it has already had.
    onWake: (agentId, was) => {
      if (was === 'out_of_memory')
        void guardStatus.release(agentId, log).catch((error: unknown) =>
          log.error('Memory guard could not release an agent’s hold', {
            agentId,
            error: error instanceof Error ? error.name : 'unknown',
          })
        );
    },
  });
  /**
   * Holds again, before anything can start them, the agents a guard stop
   * still holds from before a restart; lets go of the hold of any its owner
   * has stopped since.
   */
  const restoreGuardHolds = async (): Promise<void> => {
    const entries = unrestored;
    unrestored = [];
    if (!rest || entries.length === 0) return;
    await guardStatus.restore(
      entries.filter((entry) => entry.desired_state === 'running').map((entry) => entry.agent_id),
      rest,
      log,
      entries.filter((entry) => entry.desired_state !== 'running').map((entry) => entry.agent_id)
    );
  };
  if (deps.memoryGuard) {
    const { markers, limits } = deps.memoryGuard;
    const announce = hostAnnouncer(runtime, (agentId) => layout.watcherRoot(agentId), !split);
    const guardRest = rest;
    memoryGuard = new MemoryGuard({
      markers,
      limits,
      // Split boxes: measured and stopped through the launcher, never by this user's /proc reads,
      // and the box judged from /proc/meminfo only (the pod total under gVisor).
      ...(split ? { remote: split.guard, readBox: () => readSplitBoxMemory() } : {}),
      rest: guardRest,
      run: (task) => queue.run(task),
      stopHost: (agentId) => runtime.stop(agentId, { wait: false }),
      announce,
      hostPids: (agentId) => hostPidsFromRoot(layout.watcherRoot(agentId)),
      agentDir: (agentId) => layout.agentDir(agentId),
      log,
      now: deps.now,
      watched: () =>
        (assignment?.agents ?? [])
          .filter((entry) => entry.desired_state === 'running')
          .map((entry) => entry.agent_id),
      held: (agentId) => {
        const kind = guardRest.state(agentId)?.kind;
        return kind === 'out_of_memory' || kind === 'resting' ? kind : null;
      },
      status: guardStatus,
      onStopped: (decision, result) => {
        // A guard stop drops the agent's leases and waiters at once, not at the next read.
        boxValve.dropAgent(decision.agentId);
        guardStatus.remember(decision.agentId, result.record);
        reporter?.request();
      },
    });
  }

  let syncQueued = false;
  const sync = (why: string): Promise<void> => {
    if (syncQueued) return Promise.resolve();
    syncQueued = true;
    return queue.run(async () => {
      syncQueued = false;
      if (stop.signal.aborted) return;
      try {
        const pulled = await client.assignment(etag).catch((error: unknown) => {
          // A failed fetch proves nothing missing: leftovers wait for two good ones.
          reconcileDeps.removal?.leftovers.fetchFailed();
          throw error;
        });
        lastSyncAt = deps.now();
        if (pulled.kind === 'changed') {
          // Split boxes: an agent its owner changed is no longer failed for burnt tickets.
          if (split)
            for (const entry of pulled.assignment.agents) {
              const before = assignment?.agents.find((a) => a.agent_id === entry.agent_id);
              if (before && before.revision !== entry.revision) split.gate.clear(entry.agent_id);
            }
          assignment = pulled.assignment;
          etag = pulled.etag;
          store.saveAssignment(assignment, etag, new Date(deps.now()).toISOString());
          log.info('Pulled assignment', { revision: assignment.revision, why });
          unrestored.push(...placeAgents(assignment));
        }
        await restoreGuardHolds();
        if (assignment) await reconcile(assignment, reconcileDeps, { fetched: true });
        reporter?.request();
      } catch (error) {
        failed('Assignment sync', error);
      }
    });
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
            const problem = definitionProblem(entry);
            if (problem) return { reason: 'definition_invalid', detail: problem };
            // Asked for by its owner: started now, not on its next message.
            rest?.clear(entry.agent_id);
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
          takeUpLogin: async (provider) => {
            const status = await providers.check(provider, { verify: true });
            await reporter?.sendNow();
            void reconcileLocally();
            return { status, problem: providers.loginProblem(provider) };
          },
          log,
        });
        if (ran) reporter?.request();
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
  const liveStatus = deps.liveStatusDir
    ? new LiveStatusWriter({
        dir: deps.liveStatusDir,
        startedAt: deps.now(),
        now: deps.now,
        gather: (agentIds) =>
          gatherLiveExtras({
            agentIds,
            markers: deps.memoryGuard?.markers ?? null,
            layout,
            health: async (agentId) => {
              const health = (await runtime.observe(agentId)).health;
              return health?.current ? health : null;
            },
          }),
        events: () => liveEvents?.snapshot() ?? { events: [], droppedBefore: null },
        warn: (message, fields) => log.warn(message, fields),
      })
    : null;
  reporter = new StatusReporter({
    collect: async () => {
      const collected = await collector.collect(assignment);
      await liveStatus?.observe({
        report: collected,
        assigned: (assignment?.agents ?? []).map((entry) => ({
          agentId: entry.agent_id,
          desired: entry.desired_state === 'running' ? 'running' : 'stopped',
        })),
        restKind: (agentId) => rest?.state(agentId)?.kind ?? null,
        hubHosts: hubSocket?.hosts() ?? new Map(),
        valve: boxValve.status(),
        formulaCap: cap?.formula ?? null,
        guard: deps.memoryGuard
          ? {
              boxLimit: deps.memoryGuard.limits.podLimit ?? deps.memoryGuard.limits.boxLimit,
              backstop: deps.memoryGuard.limits.backstop,
              share: deps.memoryGuard.limits.share,
            }
          : null,
        restAfterMs: deps.restAfterMs ?? null,
        lastSyncAt,
        imageDigest: deps.imageDigest ?? null,
        launcherMode: split !== undefined,
        flags: {
          optimizeForSize: process.execArgv.includes('--optimize-for-size'),
          nodeOptionsSet: Boolean(process.env.NODE_OPTIONS?.trim()),
        },
      });
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
    log,
    failed: (error) => failed('Status report', error),
    onLocalChange: () => void reconcileLocally(),
  });

  // A login given to the machine whose sign-in check could not run (just after
  // a box wakes, before the agents container's launcher links) is tried again
  // a bounded number of times, backing off, and the agents waiting on it start
  // once it signs in, rather than at the next nudge or resync (1 Nov defect).
  // Only the provider and the try are logged, never the login.
  let uncheckedTry = 0;
  let uncheckedTimer: ReturnType<typeof setTimeout> | null = null;
  const retryUnchecked = (): void => {
    if (!providers.hasUnchecked()) {
      uncheckedTry = 0;
      return;
    }
    const waits = timing.uncheckedRetryMs ?? UNCHECKED_RETRY_MS;
    if (uncheckedTimer || stop.signal.aborted || uncheckedTry >= waits.length) return;
    const delay = waits[uncheckedTry++]!;
    log.info('A given login’s sign-in check could not run; trying it again', {
      try: uncheckedTry,
      inMs: delay,
    });
    uncheckedTimer = setTimeout(() => {
      uncheckedTimer = null;
      if (stop.signal.aborted) return;
      void providers
        .checkAll({ verify: true })
        .catch((error: unknown) => failed('Checking providers', error))
        .then(() => {
          void reconcileLocally();
          retryUnchecked();
        });
    }, delay);
    uncheckedTimer.unref?.();
  };

  const stopServingRechecks = deps.rechecks.serve(async () => {
    await deps.refreshPath();
    // A recheck is asked for by someone setting up or fixing a login, so
    // each login is tried for real, not only reported as there.
    await providers.checkAll({ verify: true });
    await reporter?.sendFresh();
    // Agents waiting on a provider can start now.
    void reconcileLocally();
    retryUnchecked();
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
          if (entry.desired_state !== 'running' || definitionProblem(entry)) continue;
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

  /**
   * Reconciles again once an agent owed a restart for new credentials has no
   * session mid-turn, or has waited `CREDENTIAL_RESTART_WAIT_MS`: a turn
   * ending changes nothing reported, so nothing else would bring it round.
   */
  const restartOwedForCredentials = async (): Promise<void> => {
    const owed = credentialRestarts.owed();
    if (owed.size === 0 || stop.signal.aborted) return;
    try {
      for (const [agentId, since] of owed) {
        const observation = await runtime.observe(agentId);
        // One not running is settled by its next start, not by a reconcile.
        if (!observation.alive) continue;
        if (noSessionMidTurn([observation]) || deps.now() - since >= CREDENTIAL_RESTART_WAIT_MS) {
          void reconcileLocally();
          return;
        }
      }
    } catch (error) {
      failed('Restarting agents owed new credentials', error);
    }
  };

  /** A hint that a chat with the agent was created or reopened: a failure costs only the head start. */
  const warmAgent = async (agentId: string, roomId: string): Promise<void> => {
    if (rest?.suspended(agentId)) {
      // Its host is stopped until it is needed: a chat opening is that. Its
      // first message starts the session.
      rest.wake(agentId, 'warm');
      return;
    }
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

  let stopLinkTicks: () => void = () => {};
  if (split) {
    split.link.listenTo({
      // Every hello: the launcher starts with everything off, and is told the settings.
      onConnected: () => {
        const operatorExec = split.operatorExec === true;
        void split.link.order({ kind: 'settings', operatorExec }).then((reply) => {
          if (!reply.ok)
            log.warn('Could not send the launcher its settings', { code: reply.code ?? 'failed' });
        });
      },
      // C6: a report about an agent this controller didn't launch is refused.
      launched: (agentId) => split.runner.currentLaunch(agentId) !== null,
      onMeasure: (measurement) => split.guard.measured(measurement),
      onState: (state: LinkState) => {
        reporter?.request();
        if (state === 'quiet') {
          // Nothing can be measured: park what is idle, so nothing grows unseen.
          log.warn('The launcher went quiet: admitting nothing, and parking idle sessions');
          void boxValve.parkIdle().catch(() => {});
        } else if (state === 'lost') {
          log.error('The launcher is lost: starting no agent until it is back');
        } else if (state === 'live') {
          // Back: the waiters and any agent that failed to start meanwhile.
          void boxValve.tick();
          void reconcileLocally();
        }
      },
      onRestarted: () => {
        // A new agents container: every host and lease is gone. Look again before admitting.
        log.warn('The agents container restarted: every agent host is gone; looking at each again');
        split.guard.reset();
        splitSettling = true;
        void reconcileLocally().finally(() => {
          splitSettling = false;
          void boxValve.tick();
        });
      },
      // Only the controller starts a host again, as for any host found gone.
      onExited: (agentId, launchId, reason) => {
        if (split.runner.launchOf(agentId) !== launchId) return;
        // Gone by itself or ended by the launcher: started again after a backoff.
        const wait = split.gate.delay(agentId);
        if (reason !== 'gone')
          log.warn('The launcher ended an agent host that failed a check', { agentId, reason });
        const timer = setTimeout(() => void reconcileLocally(), wait + 50);
        timer.unref?.();
      },
    });
    const linkTicks = setInterval(() => split.link.tick(), 1_000);
    linkTicks.unref?.();
    let listenRetry: NodeJS.Timeout | undefined;
    stopLinkTicks = () => {
      clearInterval(linkTicks);
      if (listenRetry) clearInterval(listenRetry);
    };
    // Fails closed: if the listener can't be opened, no host can
    // start (every host goes through the launcher), the box reports itself
    // unprotected, and one ERROR says so. The same address is tried again
    // every 10 s, never another one, so the box recovers by itself.
    const listen = (): Promise<string | null> =>
      split.link.listen().then(
        () => null,
        (error: unknown) => errorCode(error)
      );
    const failed = await listen();
    if (failed !== null) {
      launcherUnavailable = true;
      log.error(
        'The controller could not listen for the launcher, so no agent can start on this box; it tries the same address again every 10 s',
        { code: failed }
      );
      listenRetry = setInterval(() => {
        void listen().then((still) => {
          if (still !== null || !launcherUnavailable) return;
          launcherUnavailable = false;
          clearInterval(listenRetry);
          log.info('The controller is listening for the launcher', {});
        });
      }, timing.launcherListenRetryMs ?? LAUNCHER_LISTEN_RETRY_MS);
      listenRetry.unref?.();
    }
    log.info('Waiting for the launcher', {});
  }

  // After `placeAgents` gave the hub its cursors, before anything is started.
  await restoreGuardHolds();
  // Only now may hosts join the box valve: a held agent's re-sent waiters are dropped, not admitted.
  openValve();
  const stopValve = boxValve.watch();
  await reconcileLocally();
  if (memoryGuard && deps.memoryGuard) {
    memoryGuard.start();
    // The one line that says the guard is on, for a box's evidence.
    log.info('Memory guard on', {
      limitBytes: deps.memoryGuard.limits.podLimit ?? deps.memoryGuard.limits.boxLimit,
      reserveBytes: deps.memoryGuard.limits.reserve ?? 0,
      sharePercent: Math.round(deps.memoryGuard.limits.share * 100),
      backstopPercent: Math.round(deps.memoryGuard.limits.backstop * 100),
    });
  }
  relay.setReady();
  gateway?.gateway.setReady();

  void providers
    .refreshStale()
    .catch((error: unknown) => failed('Checking providers', error))
    .then(retryUnchecked);

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
    void restartOwedForCredentials();
    if (!stop.signal.aborted)
      void rest?.check(assignment).catch((error: unknown) => failed('Resting agents', error));
  }, timing.statusPollMs);

  // The file explorer (split boxes only): Core's file requests go to the launcher,
  // which reads as the agents' user; the controller never opens a file itself.
  let filesUp: ((reply: FilesReply) => void) | null = null;
  const filesRelay = split
    ? new FilesRelay({
        link: split.link,
        send: (reply) => filesUp?.(reply),
        labels: () =>
          topLevelLabels(
            workspaces,
            (assignment?.agents ?? []).map((entry) => ({
              name: entry.definition.name,
              displayName: entry.definition.display_name ?? null,
              directory: entry.definition.directory,
            }))
          ),
        log: (event, fields) => log.info(event, fields),
      })
    : null;
  const files: FilesChannel | undefined = filesRelay
    ? {
        attach: (send) => {
          filesUp = send;
        },
        detach: () => {
          filesUp = null;
          filesRelay.cancelAll();
        },
        frame: (frame) => {
          if (frame.type === 'files.request') filesRelay.request(frame.data);
          else if (frame.type === 'files.more') filesRelay.more(frame.data.id);
          else filesRelay.cancel(frame.data.id);
        },
      }
    : undefined;

  let ending: ControllerExit = 'stopped';
  try {
    ending = await runControllerStream({
      ...(files ? { files } : {}),
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
      log.info('Exiting for the service to start this controller on its new release.');
  } finally {
    stopServingRechecks();
    if (uncheckedTimer) clearTimeout(uncheckedTimer);
    memoryGuard?.stop();
    clearInterval(resync);
    stopValve();
    clearInterval(poll);
    signal.removeEventListener('abort', forward);
    stop.abort();
    try {
      if (revocation) await revocation;
      await memoryGuard?.settled();
      await queue.drain();
      await reporter.idle();
      await deps.selfUpdate?.settled();
    } finally {
      await runtime.close();
      await relay.close();
      await gateway?.gateway.close();
      dailyCap?.save();
      stopLinkTicks();
      await split?.link.close();
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
  /** Where each agent's sessions stood in the last report Switch took. */
  private lastSentSessions: SessionsSent | null = null;
  /** A check passed over because a report was on its way, since the last one sent. */
  private skippedAt: number | null = null;

  constructor(
    private readonly deps: {
      collect: () => Promise<Omit<StatusReport, 'seq'>>;
      send: (report: StatusReport) => Promise<void>;
      seq: () => number;
      minGapMs: number;
      log: Logger;
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
    if (this.inFlight) {
      // Not looked at: a change seen now waits for the next check.
      this.skippedAt ??= Date.now();
      return;
    }
    if (this.timer) return;
    try {
      const collected = await this.deps.collect();
      const fingerprint = statusFingerprint(collected);
      if (this.lastObservedFingerprint !== null && fingerprint !== this.lastObservedFingerprint)
        this.deps.onLocalChange();
      this.lastObservedFingerprint = fingerprint;
      // A session waking or parking alone sends a report, but is no reason to reconcile.
      if (reportFingerprint(collected) !== this.lastSentFingerprint) this.request();
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
        this.lastSentFingerprint = reportFingerprint(collected);
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
        this.lastSentFingerprint = reportFingerprint(collected);
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

  /** Logs each agent whose sessions this report moved, and how long that took. */
  private sent(report: StatusReport, checkedAt: number): void {
    for (const entry of sessionChangeEntries(this.lastSentSessions, report, {
      checkedAt,
      sentAt: Date.now(),
      skippedAt: this.skippedAt,
    }))
      this.deps.log.info(entry.message, entry.fields);
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
