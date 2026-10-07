import { hostedSkillsSchema } from '@switch-console/agent-providers';
import { z } from 'zod';
import { ReasonedError } from './errors';
import { errorMessage, type Logger } from './log';
import { isSafeSegment } from './paths';
import { type AgentObservation, type AgentRuntime, emptyObservation } from './runtime';
import {
  type AgentAssignment,
  type AgentDefinition,
  type Assignment,
  isProvider,
  type Provider,
  type ReasonCode,
} from './schemas';
import { isCredentialFailure, LAUNCH_GRACE_MS } from './status';
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
};

export type Action =
  | StartAction
  /** `write` is false when nothing is running and the agent host is already off: only the record moves. */
  | { kind: 'stop'; agentId: string; revision: number; write: boolean }
  | { kind: 'remove'; agentId: string }
  | { kind: 'invalid'; agentId: string; revision: number; detail: string; stop: boolean }
  | { kind: 'hold'; agentId: string; why: string };

function launchSkills(skills: AgentDefinition['skills']) {
  return z.union([z.tuple([]), hostedSkillsSchema]).safeParse(skills);
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
  const skillsProblem = launchSkills(entry.definition.skills).error;
  if (skillsProblem) return `The agent's skills are not valid: ${skillsProblem.message}`;
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
        why: applied === null ? 'not applied yet' : `revision ${applied} → ${entry.revision}`,
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
      else if (credentialsChanged)
        actions.push({
          ...base,
          restart: true,
          replaceIdentity: false,
          clearTakenOver: false,
          why: 'its relay endpoint or token changed',
        });
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
   * Resolves true when the file had to be (re)written.
   */
  ensureCredentials: (agentId: string) => Promise<boolean>;
  /** The agent is no longer assigned here: the relay stops accepting its token. */
  forgetAgent: (agentId: string) => void;
  binaryPath: (provider: Provider) => Promise<string | null>;
  now: () => number;
  log: Logger;
};

function reasonFor(error: unknown): ReasonCode {
  if (error instanceof ReasonedError) return error.reason;
  return 'internal';
}

export type StartFailure = { reason: ReasonCode; detail: string };

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
    await deps.ensureCredentials(agentId);
    const cwd = await deps.runtime.workingDirectory(definition.name, definition.directory);
    const binaryPath = await deps.binaryPath(provider);
    if (!binaryPath)
      throw new ReasonedError(
        'provider_not_installed',
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
    const observation = await deps.runtime.observe(agentId);
    const replaceIdentity =
      action.replaceIdentity ||
      (observation.configured !== null &&
        (observation.configured.provider !== provider || observation.configured.cwd !== cwd));
    const restart = action.restart || replaceIdentity;
    const isolation = definition.isolation === 'isolated' ? 'isolated' : 'shared';
    const skills = launchSkills(definition.skills);
    if (!skills.success)
      throw new ReasonedError('definition_invalid', `Invalid skills: ${skills.error.message}`);
    const repository = definition.repository ?? null;
    if (isolation === 'shared' && (skills.data.length > 0 || repository !== null))
      deps.log.warn(
        'A shared agent host installs no skills and clones no repository; only an isolated one does',
        {
          agentId,
          skills: skills.data.map((skill) => skill.slug),
          repository: repository !== null,
        }
      );
    await deps.runtime.launch(agentId, template, {
      isolation,
      restart,
      replaceIdentity,
      clearTakenOver: action.clearTakenOver,
      skills: skills.data,
      repository,
    });
    deps.store.recordApplied(agentId, entry.revision, now);
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

/** Carries out one action. Per-agent failures are recorded on the agent and logged. */
export async function executeAction(action: Action, deps: ReconcileDeps): Promise<void> {
  const now = new Date(deps.now()).toISOString();
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
      if (isSafeSegment(action.agentId)) {
        await deps.runtime.stop(action.agentId, { wait: false });
        await deps.runtime.deleteCredentials(action.agentId);
      }
      deps.forgetAgent(action.agentId);
      deps.store.deleteAgent(action.agentId);
      deps.log.info('Agent is no longer assigned here; stopped it and deleted its relay token', {
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
      deps.log.warn('Leaving agent as it is', { agentId: action.agentId, why: action.why });
      return;
  }
}

/** Observes every agent, plans, and carries the plan out in order. */
export async function reconcile(assignment: Assignment, deps: ReconcileDeps): Promise<Action[]> {
  const observations = new Map<string, AgentObservation>();
  const credentialsChanged = new Set<string>();
  for (const entry of assignment.agents) {
    if (definitionProblem(entry)) {
      observations.set(entry.agent_id, emptyObservation());
      continue;
    }
    try {
      observations.set(entry.agent_id, await deps.runtime.observe(entry.agent_id));
    } catch (error) {
      deps.log.warn('Could not observe agent state; treating as empty', {
        agentId: entry.agent_id,
        error: errorMessage(error),
      });
      observations.set(entry.agent_id, {
        ...emptyObservation(),
        failure: errorMessage(error),
      });
    }
    if (entry.desired_state !== 'running') continue;
    try {
      if (await deps.ensureCredentials(entry.agent_id)) credentialsChanged.add(entry.agent_id);
    } catch (error) {
      // Starting it writes them again, and records the failure on the agent.
      deps.log.error('Could not write an agent’s relay credentials', {
        agentId: entry.agent_id,
        error: errorMessage(error),
      });
    }
  }
  const actions = planReconcile({
    assignment,
    rows: deps.store.agents(),
    observations,
    credentialsChanged,
    nowMs: deps.now(),
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
  return actions;
}
