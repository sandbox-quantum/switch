import { agentEvents } from '@main/core/agents/agent-events';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getSession } from '@main/core/sessions/operations/getSession';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { TelemetryEventMap, TelemetryLocationKind } from './events';
import { agentTypeOf, locationKindOf } from './shape';
import { trackEvent } from './telemetry-service';

type SessionShape = {
  agent_type: AgentProviderId | 'unknown';
  location: TelemetryLocationKind;
};

const UNKNOWN_SESSION: SessionShape = { agent_type: 'unknown', location: 'unknown' };

/**
 * How many ended sessions to remember. Only enough to recognise a second ending
 * for the same session, which follows the first within moments; the set is
 * otherwise an unbounded record of everything that ever ran.
 */
const ENDED_SESSION_MEMORY = 256;

/**
 * What each live session is, remembered when it starts so its end can be
 * reported without a database read on a path that must stay cheap.
 */
const liveSessions = new Map<string, SessionShape>();

/**
 * Sessions that have already reported an end. A session whose agent crashed for
 * good and is deleted afterwards has ended once, not twice — without this the
 * same session counts as both a failure and a normal end.
 */
const endedSessions = new Set<string>();

function rememberEnded(sessionId: string): void {
  endedSessions.add(sessionId);
  if (endedSessions.size <= ENDED_SESSION_MEMORY) return;

  const oldest = endedSessions.values().next();
  if (!oldest.done) endedSessions.delete(oldest.value);
}

function endSession(sessionId: string, outcome: TelemetryEventMap['session_ended']['outcome']) {
  const shape = liveSessions.get(sessionId) ?? UNKNOWN_SESSION;
  // Forget it either way. A second ending reports nothing, but it must still
  // clear the entry, or a session that ends twice stays in the map for good.
  liveSessions.delete(sessionId);

  if (endedSessions.has(sessionId)) return;
  rememberEnded(sessionId);
  trackEvent('session_ended', { ...shape, outcome });
}

/**
 * Learn what a session is without reporting it as a new one.
 *
 * A session that outlives a restart is provisioned again rather than created,
 * so this run never sees it start. Recording it here is what stops its eventual
 * end being filed under `unknown` — which, since restoring live sessions is
 * routine, would otherwise be most of the ends the app ever reports.
 *
 * Provisioning also happens right after a create, and again on every re-open,
 * so the guard below usually skips the reads. Usually, not always: a create and
 * its provision run concurrently, so this occasionally repeats work the created
 * handler is doing. Two cheap reads on a path that is already opening a
 * terminal, in exchange for not having to care about the ordering.
 */
async function rememberSession(sessionId: string, locationId: string): Promise<void> {
  if (liveSessions.has(sessionId) || endedSessions.has(sessionId)) return;

  const session = await getSession(sessionId);
  if (!session) return;

  const shape: SessionShape = {
    agent_type: agentTypeOf(session.providerId),
    location: await locationKindOf(locationId),
  };

  // Checked again after the reads, for the same reason as in the created
  // handler: the session may have ended while they were in flight.
  if (endedSessions.has(sessionId)) return;
  liveSessions.set(sessionId, shape);
}

/**
 * Subscribe the telemetry emitter to the six product moments it reports.
 *
 * Deliberately one place rather than a `trackEvent` sprinkled through each
 * domain: what the app reports about itself should be readable in a single
 * file, both for review and for anyone checking the promise made to the user.
 * The two moments with no hook bus to subscribe to — a server being added and a
 * connector being installed — call `trackEvent` at their own site.
 */
export function registerTelemetryListeners(): void {
  agentEvents.on('agent:created', async (agent, entryPoint) => {
    trackEvent('agent_created', {
      agent_type: agentTypeOf(agent.providerId),
      location: await locationKindOf(agent.locationId),
      outcome: 'success',
      failure_reason: 'none',
      entry_point: entryPoint,
    });
  });

  sessionService.on('session:created', async (session, params) => {
    const agent = await getAgentById(session.agentId);
    const shape: SessionShape = {
      agent_type: agentTypeOf(session.providerId),
      location: agent ? await locationKindOf(agent.locationId) : 'unknown',
    };

    // A session is created with its agent already running, so one that dies
    // immediately can be reported as ended while this handler is still working
    // out what it was. Reporting the start now would place it after its own
    // end, and would put back an entry nothing will ever remove.
    if (endedSessions.has(session.id)) return;

    liveSessions.set(session.id, shape);
    trackEvent('session_started', {
      ...shape,
      outcome: 'success',
      failure_reason: 'none',
      entry_point: params.entryPoint ?? 'unknown',
      start_source: params.startSource ?? 'user',
      // The same test `createSession` itself applies, so the reported flag and
      // the prompt the session actually launched with cannot disagree.
      has_initial_prompt: (params.initialPrompt?.trim().length ?? 0) > 0,
      // Declared by the create-session form before the session exists, so it is
      // already recorded by the time this runs.
      connected_to_room: switchNotificationPoller.hasIntendedRoom(session.id),
    });
  });

  sessionService.on('session:runtime-ready', async (sessionId, result) => {
    await rememberSession(sessionId, result.locationId);
  });

  sessionService.on('session:deleted', (sessionId) => endSession(sessionId, 'normal'));
  sessionService.on('session:archived', (sessionId) => endSession(sessionId, 'normal'));

  // Rows deleted outside the sessionService path — the remote-session
  // reconciler pruning a session that has gone from its VM, or one terminated
  // from another client — arrive on the other bus. Subscribing to only one
  // leaves those sessions reporting a start and never an end.
  sessionHooks.on('session:deleted', (sessionId) => endSession(sessionId, 'normal'));

  // Only a decision of `failed` is an ending: the supervisor's other unexpected
  // exits are followed by a respawn, and the session goes on.
  sessionHooks.on('session:agent-exited', ({ sessionId, decision }) => {
    if (decision !== 'failed') return;
    endSession(sessionId, 'failed');
  });
}
