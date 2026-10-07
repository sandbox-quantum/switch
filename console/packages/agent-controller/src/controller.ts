import type { OpenAgentStream } from '@switch-console/agent-providers';
import { AgentHub } from './agent-hub';
import { AccessTokens, ControllerClient, type Fetch, isRevoked, type OpenWebSocket } from './api';
import { ConfigurationError } from './errors';
import { HubSocket } from './hub-socket';
import { errorMessage, type Logger } from './log';
import { processPendingOperations } from './operations';
import { isSafeSegment } from './paths';
import { definitionProblem, reconcile, type ReconcileDeps, startAgent } from './reconcile';
import { LocalRelay, RELAY_TOKEN_PREFIX } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentRuntime } from './runtime';
import {
  type AgentCursor,
  type Assignment,
  type StatusReport,
  statusReportSchema,
} from './schemas';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import {
  type ProviderLocator,
  ProviderStatuses,
  StatusCollector,
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
  eventBufferLimit: 5_000,
};

export type ControllerDeps = {
  store: ControllerStore;
  secrets: SecretStore;
  /**
   * Builds how agents run here, given the stream each agent's agent host hears
   * its events on and the folder agents with no directory of their own work in.
   */
  runtime: (openStream: (agentId: string) => OpenAgentStream, workspaces: string) => AgentRuntime;
  locator: ProviderLocator;
  fetch: Fetch;
  /** Opens the controller's connection to Switch. */
  openWebSocket: OpenWebSocket;
  log: Logger;
  /** Where disk space is measured and provider checks run. */
  dataDir: string;
  /** Where agents' working directories go when their definition names none, for a server. */
  workspacesFor: (server: string) => string;
  version: string;
  now: () => number;
  random: () => number;
  timing: ControllerTiming;
};

/**
 * `taken_over`: another instance of this controller opened the controller
 * stream after this one. Restarting would take it straight back, so this one
 * ends instead.
 */
export type ControllerExit = 'stopped' | 'revoked' | 'taken_over';

/**
 * Makes an agent's credentials file name the relay, its hub, and a token the
 * relay accepts: the token already in the file when it names both as they
 * listen now, a new one otherwise. Resolves true when the file was (re)written,
 * which a running agent host only reads when it starts, so it is restarted:
 * that is also what moves an agent host from before the hub onto it.
 */
export async function ensureRelayCredentials(
  agentId: string,
  deps: { runtime: AgentRuntime; relay: LocalRelay; log: Logger }
): Promise<boolean> {
  const current = await deps.runtime.readCredentials(agentId);
  const endpoint = deps.relay.endpoint;
  const hub = deps.relay.hubUrl;
  if (
    current &&
    current.endpoint === endpoint &&
    current.hub === hub &&
    current.token.startsWith(RELAY_TOKEN_PREFIX)
  ) {
    if (!deps.relay.isRegistered(agentId, current.token))
      deps.relay.register(agentId, current.token);
    return false;
  }
  const token = deps.relay.mint(agentId);
  await deps.runtime.writeCredentials(agentId, { endpoint, token, hub });
  deps.log.info('Wrote the agent’s relay credentials', {
    agentId,
    why: current ? 'they named another endpoint, hub or a Switch key' : 'it had none',
  });
  return true;
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
 * wipes the credential and ends the loop with `'revoked'`. A full resync runs
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
  const { store, log, timing } = deps;
  const identity = store.identity();
  if (!identity)
    throw new ConfigurationError(
      `This controller is not enrolled: ${deps.dataDir} holds no identity. Run 'switch-agent-controller enroll --server <url> --code <code>' first.`
    );
  const credential = await deps.secrets.get(CONTROLLER_CREDENTIAL);
  if (!credential) {
    const revokedAt = store.revokedAt();
    throw new ConfigurationError(
      revokedAt
        ? `This controller was revoked at ${revokedAt} and its credential wiped. Enroll it again with a new code.`
        : `The controller credential is missing from ${deps.secrets.description}. Enroll again with a new code.`
    );
  }
  const warning = deps.secrets.startupWarning();
  if (warning) log.warn(warning);
  log.info('Agents controller starting', {
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
  });
  const workspaces = deps.workspacesFor(identity.server);
  const runtime = deps.runtime(
    (agentId) => (streamDeps) => hub.open(agentId, streamDeps),
    workspaces
  );
  const relay = new LocalRelay({
    log,
    roomFor: (agentId, sessionId) => hub.roomFor(agentId, sessionId),
    hub: new HubSocket({ hub, log }),
    forwarder: new UpstreamForwarder({
      server: identity.server,
      auth: {
        token: () => tokens.get(),
        invalidate: (token) => tokens.invalidate(token),
        revoked: () => void revoke(),
      },
      log,
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

  const failed = (what: string, error: unknown) => {
    if (isRevoked(error)) {
      void revoke();
      return;
    }
    log.warn(`${what} failed; it is retried on the next nudge, reconnect or resync.`, {
      error: errorMessage(error),
    });
  };

  const providers = new ProviderStatuses({
    locator: deps.locator,
    runtime,
    probeCwd: deps.dataDir,
    now: deps.now,
    log,
    onChange: () => reporter?.request(),
  });
  const collector = new StatusCollector({
    store,
    runtime,
    providers,
    attached: (agentId) => hub.attached(agentId),
    dataDir: deps.dataDir,
    workspacesDir: workspaces,
    version: deps.version,
    now: deps.now,
  });
  const reconcileDeps: ReconcileDeps = {
    store,
    runtime,
    ensureCredentials: (agentId) => ensureRelayCredentials(agentId, { runtime, relay, log }),
    forgetAgent: (agentId) => {
      relay.unregister(agentId);
      hub.forget(agentId);
    },
    binaryPath: (provider) => providers.binaryPath(provider),
    now: deps.now,
    log,
  };

  let syncQueued = false;
  const sync = (why: string): Promise<void> => {
    if (syncQueued) return Promise.resolve();
    syncQueued = true;
    return queue.run(async () => {
      syncQueued = false;
      if (stop.signal.aborted) return;
      try {
        const pulled = await client.assignment(etag);
        if (pulled.kind === 'changed') {
          assignment = pulled.assignment;
          etag = pulled.etag;
          store.saveAssignment(assignment, etag, new Date(deps.now()).toISOString());
          log.info('Pulled assignment', { revision: assignment.revision, why });
          placeAgents(assignment);
        }
        if (assignment) await reconcile(assignment, reconcileDeps);
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
            const status = await providers.check(provider);
            await reporter?.sendNow();
            return status;
          },
          log,
        });
        if (ran) reporter?.request();
      } catch (error) {
        failed('Running operations', error);
      }
    });
  };

  reporter = new StatusReporter({
    collect: () => collector.collect(assignment),
    send: async (report) => {
      const answer = await client.putStatus(report);
      reportWithinS = answer.report_within_s;
      if (assignment === null || answer.assignment_revision > assignment.revision)
        void sync('status says the assignment moved on');
    },
    seq: () => store.nextStatusSeq(deps.now()),
    minGapMs: timing.statusMinGapMs,
    failed: (error) => failed('Status report', error),
    onLocalChange: () => void reconcileLocally(),
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

  await reconcileLocally();
  relay.setReady();

  void providers.refreshStale().catch((error: unknown) => failed('Checking providers', error));

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
    });
    if (ending === 'revoked') await revoke();
    if (ending === 'taken_over')
      log.error(
        'Another instance of this controller took over its connection to Switch; this one stops its agents and exits.'
      );
  } finally {
    clearInterval(resync);
    clearInterval(poll);
    signal.removeEventListener('abort', forward);
    stop.abort();
    try {
      if (revocation) await revocation;
      await queue.drain();
      await reporter.idle();
    } finally {
      await runtime.close();
      await relay.close();
    }
  }
  return revocation ? 'revoked' : ending;
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

  constructor(
    private readonly deps: {
      collect: () => Promise<Omit<StatusReport, 'seq'>>;
      send: (report: StatusReport) => Promise<void>;
      seq: () => number;
      minGapMs: number;
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
    if (this.inFlight || this.timer) return;
    try {
      const fingerprint = statusFingerprint(await this.deps.collect());
      if (this.lastObservedFingerprint !== null && fingerprint !== this.lastObservedFingerprint)
        this.deps.onLocalChange();
      this.lastObservedFingerprint = fingerprint;
      if (fingerprint !== this.lastSentFingerprint) this.request();
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
        const collected = await this.deps.collect();
        const report = statusReportSchema.parse({ ...collected, seq: this.deps.seq() });
        this.lastSentAt = Date.now();
        await this.deps.send(report);
        this.lastSentFingerprint = statusFingerprint(collected);
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

  /** Stops sending, and waits for a report already on its way. */
  async idle(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    await this.inFlight;
  }
}
