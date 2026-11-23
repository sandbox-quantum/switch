import {
  providerLoginEnvironment,
  providerUnsupportedReason,
  removeHostedLoginFiles,
} from '@switch-console/agent-providers-box';
import {
  type AgentRemovalDeps,
  deleteAgentFolders,
  deleteLoginCopies,
  type LeftoverWatch,
  leftoverAgents,
  logRemoval,
} from './agent-removal';
import { ReasonedError } from './errors';
import { errorCode, errorMessage, type Logger } from './log';
import { isSafeSegment } from './paths';
import { type AgentObservation, type AgentRuntime, emptyObservation } from './runtime';
import {
  type AgentAssignment,
  type Assignment,
  isProvider,
  type Provider,
  type ReasonCode,
} from './schemas';
import type { GivenLogin } from './sealed-logins';
import { isCredentialFailure, LAUNCH_GRACE_MS, noSessionMidTurn } from './status';
import type { AgentRow, ControllerStore } from './store';
import { advancedConfigDefinitionProblem, buildWatcherTemplate } from './template';

export type StartAction = {
  kind: 'start';
  agentId: string;
  entry: AgentAssignment;
  restart: boolean;
  replaceIdentity: boolean;
  clearTakenOver: boolean;
  /** Counted in `restarts_10m`: anything but the first start of an agent here. */
  relaunch: boolean;
  why: string;
  /** False for a restart nobody in its rooms asked for: a cut-off turn owes its line. */
  asked?: boolean;
};

export type Action =
  | StartAction
  /** `write` is false when nothing is running and the agent host is already off: only the record moves. */
  | { kind: 'stop'; agentId: string; revision: number; write: boolean }
  | { kind: 'remove'; agentId: string }
  | { kind: 'invalid'; agentId: string; revision: number; detail: string; stop: boolean }
  | {
      kind: 'hold';
      agentId: string;
      why: string;
      /** Held for a restart owed for new credentials: said once per debt, not every pass. */
      owedCredentials?: true;
    };

/** How long a restart for new credentials waits for a session's turn to end before it goes ahead anyway. */
export const CREDENTIAL_RESTART_WAIT_MS = 10 * 60 * 1000;

/**
 * The agents owed a restart because their relay credentials (or the login
 * in them) were rewritten while their host ran busy. `ensureCredentials`
 * says a file was rewritten only on the pass that rewrites it, so the debt is
 * kept here until a start pays it. In memory only: a controller that restarts
 * starts every host afresh, on the credentials as written.
 */
export class CredentialRestarts {
  private readonly since = new Map<string, number>();
  private readonly held = new Set<string>();

  owe(agentId: string, nowMs: number): void {
    if (!this.since.has(agentId)) this.since.set(agentId, nowMs);
  }

  settle(agentId: string): void {
    this.since.delete(agentId);
    this.held.delete(agentId);
  }

  /** True the first time the agent's restart is held for this debt: the hold is logged once, not every pass. */
  firstHold(agentId: string): boolean {
    if (this.held.has(agentId)) return false;
    this.held.add(agentId);
    return true;
  }

  owed(): Map<string, number> {
    return new Map(this.since);
  }
}

/** Why an assigned agent cannot be applied on this machine as defined, or null when it can. */
export function definitionProblem(entry: AgentAssignment): string | null {
  if (!isSafeSegment(entry.agent_id))
    return `The agent id '${entry.agent_id}' cannot be used as a directory name.`;
  if (!isProvider(entry.definition.provider))
    return `This controller does not run the provider '${entry.definition.provider}'.`;
  const advancedProblem = advancedConfigDefinitionProblem(
    entry.definition.provider,
    entry.definition
  );
  if (advancedProblem) return advancedProblem;
  if (entry.definition.isolation === 'unknown')
    return 'This controller does not know the isolation this agent asks for.';
  if (entry.definition.directory === null && !isSafeSegment(entry.definition.name))
    return `The agent name '${entry.definition.name}' cannot be used as a workspace directory name; set a directory.`;
  return null;
}

/**
 * Decides what to do for each agent, from the assignment, what was applied,
 * and what is running. Pure: it reads nothing and changes nothing.
 *
 * Running agents are started when never applied. When their revision moved,
 * the new definition is written to the running agent host, which brings its
 * live sessions in step as each finishes its turn; the agent host is
 * restarted only when the provider or working directory changed, since those
 * cannot carry over to its sessions. They are started again when
 * their agent host is gone without a recorded failure (a reboot, say) once the
 * launch grace has passed, so an agent host still coming up is not launched
 * twice. A running agent host whose relay credentials were just rewritten (the
 * relay came back on another port) is restarted, since it reads them only
 * when it starts. An agent host that failed, or stood down because another client
 * took its connection, stays down until a new revision or an explicit
 * restart; one that failed on its relay token is relaunched only when the
 * credentials were rewritten since. A revision older than the one applied is
 * refused.
 */
export function planReconcile(input: {
  assignment: Assignment;
  rows: AgentRow[];
  observations: Map<string, AgentObservation>;
  /** Agents whose relay credentials file was rewritten in this pass. */
  credentialsChanged: Set<string>;
  nowMs: number;
  /**
   * Agents whose agent host is stopped on purpose until their next message
   * (resting, or stopped by the memory guard; `AgentRest`). Not started for
   * being down, nor restarted for new credentials, which their next start
   * reads; a new revision still starts them.
   */
  suspended?: Set<string>;
  /**
   * When each agent first became owed a restart for new credentials
   * (`CredentialRestarts`): one whose session is mid-turn waits for the
   * turn, up to `CREDENTIAL_RESTART_WAIT_MS` from then.
   */
  credentialsOwedSince?: Map<string, number>;
}): Action[] {
  const actions: Action[] = [];
  const rows = new Map(input.rows.map((row) => [row.agentId, row]));
  const assigned = new Set<string>();
  for (const entry of input.assignment.agents) {
    const agentId = entry.agent_id;
    assigned.add(agentId);
    const row = rows.get(agentId) ?? null;
    const observation = input.observations.get(agentId);
    if (!observation) throw new Error(`No observation of agent ${agentId} to reconcile against.`);
    const applied = row?.appliedRevision ?? null;
    const problem = definitionProblem(entry);
    if (problem) {
      if (row?.failure?.revision !== entry.revision || observation.alive)
        actions.push({
          kind: 'invalid',
          agentId,
          revision: entry.revision,
          detail: problem,
          stop: observation.alive,
        });
      continue;
    }
    if (applied !== null && applied > entry.revision) {
      actions.push({
        kind: 'hold',
        agentId,
        why: `revision ${entry.revision} is older than the applied revision ${applied}`,
      });
      continue;
    }
    if (entry.desired_state === 'unknown') {
      actions.push({
        kind: 'hold',
        agentId,
        why: 'the desired state is not one this controller knows',
      });
      continue;
    }
    if (entry.desired_state === 'stopped') {
      const off = observation.flags === null || observation.flags.enabled === false;
      if (observation.alive || !off) {
        if (observation.flags?.enabled !== false || applied !== entry.revision)
          actions.push({ kind: 'stop', agentId, revision: entry.revision, write: true });
      } else if (applied !== entry.revision)
        actions.push({ kind: 'stop', agentId, revision: entry.revision, write: false });
      continue;
    }
    const suspended = input.suspended?.has(agentId) ?? false;
    if (suspended && applied !== null && applied >= entry.revision) continue;
    const credentialsChanged = input.credentialsChanged.has(agentId);
    const base = {
      kind: 'start' as const,
      agentId,
      entry,
      relaunch: applied !== null || observation.configured !== null,
    };
    if (applied === null || applied < entry.revision) {
      // The working directory is resolved when starting, and compared there too.
      const replaceIdentity =
        observation.configured !== null &&
        observation.configured.provider !== entry.definition.provider;
      actions.push({
        ...base,
        restart: replaceIdentity || (observation.alive && observation.flags?.enabled === false),
        replaceIdentity,
        clearTakenOver: true,
        why:
          (applied === null ? 'not applied yet' : `revision ${applied} → ${entry.revision}`) +
          (suspended ? ' (its host was stopped until its next message)' : ''),
      });
      continue;
    }
    if (observation.alive) {
      if (observation.flags?.enabled === false)
        actions.push({
          ...base,
          restart: true,
          replaceIdentity: false,
          clearTakenOver: false,
          why: 'its agent host is being turned off',
        });
      else if (credentialsChanged) {
        // A login given or changed while a reply is being written would cut
        // it off with no line to the room: wait for the turn to end,
        // as a self-update does, but not for ever.
        // Only a login change waits (`credentialsOwedSince` holds those): the
        // relay keeps the host's token then, so the running turn can finish.
        // A new endpoint or token has already cut the old host off.
        const owedSince = input.credentialsOwedSince?.get(agentId);
        if (
          owedSince !== undefined &&
          !noSessionMidTurn([observation]) &&
          input.nowMs - owedSince < CREDENTIAL_RESTART_WAIT_MS
        )
          actions.push({
            kind: 'hold',
            agentId,
            why: 'a session is mid-turn; it restarts for its new relay endpoint or token once the turn ends',
            owedCredentials: true,
          });
        else
          actions.push({
            ...base,
            restart: true,
            replaceIdentity: false,
            clearTakenOver: false,
            // Nobody in its rooms asked for it: a turn it cuts off owes its line.
            asked: false,
            why:
              owedSince !== undefined && input.nowMs - owedSince >= CREDENTIAL_RESTART_WAIT_MS
                ? 'its relay endpoint or token changed; a session was still mid-turn after the wait'
                : 'its relay endpoint or token changed',
          });
      }
      continue;
    }
    if (observation.takenOver) continue;
    if (observation.failure) {
      if (isCredentialFailure(observation.failure) && credentialsChanged)
        actions.push({
          ...base,
          restart: false,
          replaceIdentity: false,
          clearTakenOver: false,
          why: 'its relay token was refused, and it has a new one',
        });
      continue;
    }
    // Launched moments ago: the agent host writes the records that show it alive
    // only once it is up, and launching again now would race the first.
    if (row && input.nowMs - Date.parse(row.changedAt) < LAUNCH_GRACE_MS) continue;
    actions.push({
      ...base,
      restart: false,
      replaceIdentity: false,
      clearTakenOver: false,
      why: 'its agent host is not running',
    });
  }
  for (const row of input.rows)
    if (!assigned.has(row.agentId)) actions.push({ kind: 'remove', agentId: row.agentId });
  return actions;
}

export type ReconcileDeps = {
  store: ControllerStore;
  runtime: AgentRuntime;
  /**
   * Makes the agent's credentials file name the relay and a token it accepts.
   * Resolves false when nothing changed, `'login'` when only the provider
   * login in it was given or changed (the relay still takes the old token, so
   * a running host keeps working), `'withdrawn'` when the login it named is
   * no longer to be used, and `'relay'` or true when the endpoint, hub or
   * token changed (a running host is cut off from the relay).
   */
  ensureCredentials: (agentId: string, provider: string) => Promise<CredentialChange>;
  /** The login Switch gave the machine for `provider`, when its agents use it rather than the machine's own. */
  givenLogin: (provider: Provider) => Promise<GivenLogin | null>;
  /**
   * With a provider gateway: the CLI environment for an agent's gateway-backed
   * login (a local base URL and its opaque token), or null when the login
   * isn't one. Absent, logins go in the environment as they are.
   */
  gatewayEnv?: (agentId: string, login: GivenLogin) => Promise<Record<string, string> | null>;
  /** The agent is no longer assigned here: the relay stops accepting its token. */
  forgetAgent: (agentId: string) => void;
  binaryPath: (provider: Provider) => Promise<string | null>;
  /**
   * Where a removed agent's files are, to delete them, and when its
   * leftover folders may go; absent, only its relay token goes.
   */
  removal?: AgentRemovalDeps & { leftovers: LeftoverWatch };
  now: () => number;
  log: Logger;
  /** Agents whose agent host is stopped until their next message; absent where none are. */
  rest?: { suspended(agentId: string): boolean; clear(agentId: string): void };
  /** Restarts owed for new credentials while a session was mid-turn; absent, none wait. */
  credentialRestarts?: CredentialRestarts;
};

function reasonFor(error: unknown): ReasonCode {
  if (error instanceof ReasonedError) return error.reason;
  return 'internal';
}

export type StartFailure = { reason: ReasonCode; detail: string };

/**
 * What `ensureCredentials` rewrote: nothing, a login given or changed (the
 * only change that waits for a turn), a login withdrawn, or the relay
 * endpoint or token (true, from older callers).
 */
export type CredentialChange = false | 'login' | 'withdrawn' | 'relay' | boolean;

/**
 * Starts or restarts one agent at its assigned revision. A failure is recorded
 * on the agent and returned, not thrown.
 */
export async function startAgent(
  action: StartAction,
  deps: ReconcileDeps
): Promise<StartFailure | null> {
  const { agentId, entry } = action;
  const definition = entry.definition;
  const nowMs = deps.now();
  const now = new Date(nowMs).toISOString();
  try {
    const provider = definition.provider;
    if (!isProvider(provider))
      throw new ReasonedError('definition_invalid', `Unknown provider '${provider}'.`);
    await deps.ensureCredentials(agentId, provider);
    const login = await deps.givenLogin(provider);
    const cwd = await deps.runtime.workingDirectory(agentId, definition.name, definition.directory);
    const binaryPath = await deps.binaryPath(provider);
    if (!binaryPath)
      throw new ReasonedError(
        'provider_not_installed',
        providerUnsupportedReason(provider, process.platform) ??
          `The ${provider} CLI was not found on this machine's PATH.`
      );
    const template = buildWatcherTemplate({
      agentId,
      provider,
      definition,
      cwd,
      credentialsPath: deps.runtime.credentialsPath(agentId),
      binaryPath,
    });
    // A login Switch gave the machine: its environment goes in the agent's
    // configuration, and its files are written by the agent host, which then
    // runs in a process of its own.
    if (login) {
      // Through the provider gateway the CLI gets its base URL and token,
      // never the login. With the gateway on, a login it can't front isn't
      // used at all: no login goes in the environment.
      const loginEnv = deps.gatewayEnv
        ? await deps.gatewayEnv(agentId, login)
        : providerLoginEnvironment(deps.runtime.agentStateRoot(agentId), login);
      if (loginEnv) template.start.input.env = { ...template.start.input.env, ...loginEnv };
    }
    const observation = await deps.runtime.observe(agentId);
    const replaceIdentity =
      action.replaceIdentity ||
      (observation.configured !== null &&
        (observation.configured.provider !== provider || observation.configured.cwd !== cwd));
    const restart = action.restart || replaceIdentity;
    // The host it starts writes the login it is given now: a copy of one
    // withdrawn or replaced since must not outlive the host that used it.
    if (restart || !observation.alive) await removeLoginFiles(agentId, deps, 'its host starts');
    await deps.runtime.launch(agentId, template, {
      isolation: definition.isolation === 'isolated' || login ? 'isolated' : 'shared',
      restart,
      replaceIdentity,
      clearTakenOver: action.clearTakenOver,
      ...(action.asked === false ? { asked: false } : {}),
    });
    deps.store.recordApplied(agentId, entry.revision, now);
    // Whatever (re)started its host (a reconcile, a wake, an owner's
    // restart), it now runs on the credentials as written: no restart is owed
    // for them. A running host only handed a new definition still is.
    if (restart || !observation.alive) deps.credentialRestarts?.settle(agentId);
    if (action.relaunch && (restart || !observation.alive))
      deps.store.recordRestart(agentId, nowMs);
    deps.log.info('Started agent', { agentId, revision: entry.revision, why: action.why });
    return null;
  } catch (error) {
    const reason = reasonFor(error);
    const detail = errorMessage(error);
    deps.store.recordFailure(agentId, { revision: entry.revision, reason, detail }, now);
    deps.log.error('Could not start agent', {
      agentId,
      revision: entry.revision,
      reason,
      error: detail,
    });
    return { reason, detail };
  }
}

/** Deletes the given login's files under the agent's host root (`removeHostedLoginFiles`), saying which. */
async function removeLoginFiles(agentId: string, deps: ReconcileDeps, why: string): Promise<void> {
  const removed = await removeHostedLoginFiles(deps.runtime.agentStateRoot(agentId));
  if (removed.length) deps.log.info('Deleted the agent’s login copies', { agentId, why, removed });
}

/** Carries out one action. Per-agent failures are recorded on the agent and logged. */
export async function executeAction(action: Action, deps: ReconcileDeps): Promise<void> {
  const now = new Date(deps.now()).toISOString();
  // Stopped, removed, invalid or started at a new revision: no longer waiting
  // for its next message, so that message neither starts it nor is kept for it.
  if (action.kind !== 'hold' && deps.rest?.suspended(action.agentId))
    deps.rest.clear(action.agentId);
  // Stopped or gone: nothing owed. A start settles it in `startAgent`.
  if (action.kind === 'stop' || action.kind === 'remove' || action.kind === 'invalid')
    deps.credentialRestarts?.settle(action.agentId);
  switch (action.kind) {
    case 'start':
      await startAgent(action, deps);
      return;
    case 'stop':
      if (action.write) await deps.runtime.stop(action.agentId, { wait: false });
      deps.store.recordApplied(action.agentId, action.revision, now);
      deps.log.info('Stopped agent', { agentId: action.agentId, revision: action.revision });
      return;
    case 'remove':
      // An id that was never safe to put in a path never got an agent host or a key.
      if (isSafeSegment(action.agentId)) await removeAgent(action.agentId, deps);
      deps.forgetAgent(action.agentId);
      deps.store.deleteAgent(action.agentId);
      deps.log.info('Agent is no longer assigned here; stopped it and deleted its files', {
        agentId: action.agentId,
      });
      return;
    case 'invalid':
      if (action.stop) await deps.runtime.stop(action.agentId, { wait: false });
      deps.store.recordFailure(
        action.agentId,
        { revision: action.revision, reason: 'definition_invalid', detail: action.detail },
        now
      );
      deps.log.error('Agent definition cannot be applied', {
        agentId: action.agentId,
        detail: action.detail,
      });
      return;
    case 'hold':
      // A restart owed for new credentials is re-planned every pass until the
      // turn ends: said when it starts waiting, not on every status poll.
      if (action.owedCredentials && deps.credentialRestarts?.firstHold(action.agentId) === false)
        return;
      deps.log.warn('Leaving agent as it is', { agentId: action.agentId, why: action.why });
      return;
  }
}

/**
 * Removes an agent from this machine: its login copies first, whatever
 * follows, then its agent host stopped and waited for. Its folders and
 * session folders go at the end of the same reconcile, once its host is
 * proven gone (`removeLeftovers`).
 */
async function removeAgent(agentId: string, deps: ReconcileDeps): Promise<void> {
  if (deps.removal)
    logRemoval(deps.log, agentId, 'login copies', await deleteLoginCopies(deps.removal, agentId));
  await deps.runtime.stop(agentId, { wait: true });
  await deps.runtime.deleteCredentials(agentId);
}

/**
 * Deletes what is left on disk of agents this machine no longer runs: neither
 * assigned nor known to the store. That is an agent removed, one removed
 * while the controller was not running, or one removed before removal deleted
 * folders (box A held 55 such on 27 Oct). Called only straight after a
 * successful fetch of `assignment`, and only for agents `LeftoverWatch` says
 * have been missing long enough. One whose agent host is still running is
 * left alone, and found again by a later reconcile.
 */
export async function removeLeftovers(assignment: Assignment, deps: ReconcileDeps): Promise<void> {
  if (!deps.removal) return;
  const keep = new Set<string>([
    ...assignment.agents.map((entry) => entry.agent_id),
    ...deps.store.agents().map((row) => row.agentId),
  ]);
  const candidates = await leftoverAgents(deps.removal.layout, keep);
  for (const agentId of deps.removal.leftovers.due(
    candidates,
    assignment.agents.length,
    deps.now()
  )) {
    if ((await deps.runtime.observe(agentId)).alive) {
      deps.log.warn('A removed agent’s host is still running; its folders are kept for now', {
        agentId,
      });
      continue;
    }
    logRemoval(deps.log, agentId, 'login copies', await deleteLoginCopies(deps.removal, agentId));
    logRemoval(deps.log, agentId, 'folders', await deleteAgentFolders(deps.removal, agentId));
  }
}

/**
 * Observes every agent, plans, and carries the plan out in order. With
 * `fetched` (the assignment was just fetched from Switch, not held from an
 * earlier fetch), removed agents' leftover folders are considered too.
 */
export async function reconcile(
  assignment: Assignment,
  deps: ReconcileDeps,
  options: { fetched?: boolean } = {}
): Promise<Action[]> {
  const observations = new Map<string, AgentObservation>();
  const credentialsChanged = new Set<string>();
  const loginOnly = new Set<string>();
  for (const entry of assignment.agents) {
    if (definitionProblem(entry)) {
      observations.set(entry.agent_id, emptyObservation());
      continue;
    }
    observations.set(entry.agent_id, await deps.runtime.observe(entry.agent_id));
    if (entry.desired_state !== 'running') continue;
    try {
      const change = await deps.ensureCredentials(entry.agent_id, entry.definition.provider);
      if (change) credentialsChanged.add(entry.agent_id);
      if (change === 'login') loginOnly.add(entry.agent_id);
      // The relay cut the old host off, or the login it runs on was
      // withdrawn: it restarts at once, owing nothing.
      else if (change) deps.credentialRestarts?.settle(entry.agent_id);
      // A withdrawn login's copy goes now, resting agent or not, not when
      // its host next starts.
      if (change === 'withdrawn')
        await removeLoginFiles(entry.agent_id, deps, 'the login was withdrawn');
      // An agent whose host isn't running (resting, stopped, failed, never
      // started) isn't using its copy of a login that has just changed: it
      // goes now, and the host's next start writes the new one.
      else if (change === 'login' && !observations.get(entry.agent_id)?.alive)
        await removeLoginFiles(
          entry.agent_id,
          deps,
          'the login changed while its host is not running'
        );
    } catch (error) {
      // Starting it writes them again, and records the failure on the agent.
      deps.log.error('Could not write an agent’s relay credentials', {
        agentId: entry.agent_id,
        error: errorMessage(error),
      });
    }
  }
  const owedRestarts = deps.credentialRestarts;
  if (owedRestarts) {
    for (const agentId of loginOnly) owedRestarts.owe(agentId, deps.now());
    for (const agentId of owedRestarts.owed().keys()) credentialsChanged.add(agentId);
  }
  const actions = planReconcile({
    assignment,
    rows: deps.store.agents(),
    observations,
    credentialsChanged,
    credentialsOwedSince: owedRestarts?.owed(),
    nowMs: deps.now(),
    suspended: new Set(
      assignment.agents
        .map((entry) => entry.agent_id)
        .filter((agentId) => deps.rest?.suspended(agentId))
    ),
  });
  for (const action of actions) {
    try {
      await executeAction(action, deps);
    } catch (error) {
      deps.log.error('Reconcile step failed', {
        agentId: action.agentId,
        action: action.kind,
        error: errorMessage(error),
      });
    }
  }
  if (options.fetched)
    try {
      await removeLeftovers(assignment, deps);
    } catch (error) {
      deps.log.error('Could not clear removed agents’ leftover files', {
        error: errorCode(error),
      });
    }
  return actions;
}
