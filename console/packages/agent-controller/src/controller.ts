import type { OpenAgentStream } from '@switch-console/agent-providers';
import { AgentHub } from './agent-hub';
import {
  AccessTokens,
  ControllerClient,
  type Fetch,
  isCredentialRefused,
  isRevoked,
  isUpgradeRequired,
  type OpenWebSocket,
} from './api';
import { ConfigurationError } from './errors';
import { HubSocket } from './hub-socket';
import { errorMessage, type Logger } from './log';
import { processPendingOperations } from './operations';
import { isSafeSegment } from './paths';
import type { ProviderRechecks } from './provider-rechecks';
import { definitionProblem, reconcile, type ReconcileDeps, startAgent } from './reconcile';
import { LocalRelay, RELAY_TOKEN_PREFIX } from './relay';
import { UpstreamForwarder } from './relay-forward';
import type { AgentRuntime } from './runtime';
import {
  type AgentCursor,
  type Assignment,
  isProvider,
  type StatusReport,
  statusReportSchema,
  type ToolStatus,
  type UpdatedBy,
} from './schemas';
import { type GivenLogin, registerSealingKey, SealedLogins, sealingKeys } from './sealed-logins';
import { CONTROLLER_CREDENTIAL, type SecretStore } from './secrets';
import type { SelfUpdater } from './self-update';
import {
  noSessionMidTurn,
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
  runtime: (openStream: (agentId: string) => OpenAgentStream, workspaces: string) => AgentRuntime;
  locator: ProviderLocator;
  /**
   * Requests to check every provider again now, served while the controller
   * runs. `refreshPath` runs first, so a CLI installed since is found.
   */
  rechecks: ProviderRechecks;
  refreshPath: () => Promise<void>;
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
function sameLogin(a: GivenLogin | null, b: GivenLogin | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.provider === b.provider &&
    a.revision === b.revision &&
    a.kind === b.kind &&
    a.credential === b.credential
  );
}

export async function ensureRelayCredentials(
  agentId: string,
  providerLogin: GivenLogin | null,
  deps: { runtime: AgentRuntime; relay: LocalRelay; log: Logger }
): Promise<boolean> {
  const current = await deps.runtime.readCredentials(agentId);
  const endpoint = deps.relay.endpoint;
  const hub = deps.relay.hubUrl;
  const relayCurrent =
    current !== null &&
    current.endpoint === endpoint &&
    current.hub === hub &&
    current.token.startsWith(RELAY_TOKEN_PREFIX);
  const loginCurrent = sameLogin(current?.providerLogin ?? null, providerLogin);
  if (current && relayCurrent && loginCurrent) {
    if (!deps.relay.isRegistered(agentId, current.token))
      deps.relay.register(agentId, current.token);
    return false;
  }
  const token = current && relayCurrent ? current.token : deps.relay.mint(agentId);
  if (current && relayCurrent && !deps.relay.isRegistered(agentId, token))
    deps.relay.register(agentId, token);
  await deps.runtime.writeCredentials(agentId, { endpoint, token, hub, providerLogin });
  deps.log.info('Wrote the agent’s relay credentials', {
    agentId,
    why: !current
      ? 'it had none'
      : !relayCurrent
        ? 'they named another endpoint, hub or a Switch key'
        : providerLogin
          ? `the ${providerLogin.provider} login given to this machine changed`
          : 'the login given to this machine is no longer used',
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
  const providers = new ProviderStatuses({
    locator: deps.locator,
    runtime,
    sealed,
    probeCwd: deps.dataDir,
    now: deps.now,
    log,
    onChange: () => reporter?.request(),
  });
  const collector = new StatusCollector({
    store,
    runtime,
    providers,
    tools: deps.tools,
    attached: (agentId) => hub.attached(agentId),
    dataDir: deps.dataDir,
    workspacesDir: workspaces,
    version: deps.version,
    updatedBy: deps.updatedBy,
    now: deps.now,
  });
  const reconcileDeps: ReconcileDeps = {
    store,
    runtime,
    ensureCredentials: async (agentId, provider) =>
      ensureRelayCredentials(
        agentId,
        isProvider(provider) ? await providers.givenLogin(provider) : null,
        { runtime, relay, log }
      ),
    givenLogin: (provider) => providers.givenLogin(provider),
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
            // Agents move onto a login given since, or off one withdrawn.
            void reconcileLocally();
            return status;
          },
          takeUpLogin: async (provider) => {
            const status = await providers.check(provider);
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
  reporter = new StatusReporter({
    collect: async () => {
      const collected = await collector.collect(assignment);
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
    failed: (error) => failed('Status report', error),
    onLocalChange: () => void reconcileLocally(),
  });

  const stopServingRechecks = deps.rechecks.serve(async () => {
    await deps.refreshPath();
    await providers.checkAll();
    await reporter?.sendFresh();
    // Agents waiting on a provider can start now.
    void reconcileLocally();
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

  /** A hint from someone typing to the agent: a failure costs only the head start. */
  const warmAgent = async (agentId: string, roomId: string): Promise<void> => {
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
    // A turn ending changes nothing reported, so it would otherwise wait for
    // the next periodic report to let the update through.
    if (deps.selfUpdate?.status()?.state === 'waiting_idle') offerRelease();
    void restartOutdated();
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
        const collected = await this.deps.collect();
        const report = statusReportSchema.parse({ ...collected, seq: this.deps.seq() });
        this.lastSentAt = Date.now();
        await this.deps.send(report);
        this.lastSentFingerprint = statusFingerprint(collected);
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

  /** Stops sending, and waits for a report already on its way. */
  async idle(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.again = false;
    await this.inFlight;
  }
}
