import { agentEvents } from '@main/core/agents/agent-events';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getSession } from '@main/core/sessions/operations/getSession';
import { type SessionRemovedBy, sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { agentTypeOf } from './agent-type';
import type { TelemetryLocationKind } from './events';
import { entryPointOf, startSourceOf } from './narrow';
import { locationKindOf } from './shape';
import { trackBackgroundEvent, trackEvent } from './telemetry-service';

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

/**
 * Report a session's end. One a person ended is someone using the app; one
 * that went because the app removed its agent on its own is not, and is sent
 * in no session, so a pass running while nobody is there does not start one.
 */
function endSession(sessionId: string, removedBy: SessionRemovedBy) {
  const shape = liveSessions.get(sessionId) ?? UNKNOWN_SESSION;
  // Forget it either way. A second ending reports nothing, but it must still
  // clear the entry, or a session that ends twice stays in the map for good.
  liveSessions.delete(sessionId);

  if (endedSessions.has(sessionId)) return;
  rememberEnded(sessionId);
  const report = removedBy === 'app' ? trackBackgroundEvent : trackEvent;
  report('session_ended', { ...shape, outcome: 'normal' });
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
 * Subscribe the telemetry emitter to the product moments it reports.
 *
 * Deliberately one place rather than a `trackEvent` sprinkled through each
 * domain: what the app reports about itself should be readable in a single
 * file, both for review and for anyone checking the promise made to the user.
 * Moments with no hook bus to subscribe to, such as a server being added, call
 * `trackEvent` at their own site.
 */
export function registerTelemetryListeners(): void {
  agentEvents.on('agent:created', async (agent, entryPoint, origin) => {
    const shape = {
      agent_type: agentTypeOf(agent.providerId),
      location: await locationKindOf(agent.locationId),
    };
    if (origin === 'attached') {
      trackEvent('agent_attached', shape);
      return;
    }
    if (origin === 'adopted') {
      trackEvent('subagent_adopted', shape);
      return;
    }
    trackEvent('agent_created', {
      ...shape,
      outcome: 'success',
      failure_reason: 'none',
      entry_point: entryPointOf(entryPoint),
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
    const startSource = startSourceOf(params.startSource);
    if (startSource === 'adopted') {
      trackEvent('session_discovered', shape);
      return;
    }
    trackEvent('session_started', {
      ...shape,
      outcome: 'success',
      failure_reason: 'none',
      entry_point: entryPointOf(params.entryPoint),
      start_source: startSource,
      // The same test `createSession` itself applies, so the reported flag and
      // the prompt the session actually launched with cannot disagree.
      has_initial_prompt: (params.initialPrompt?.trim().length ?? 0) > 0,
      // Declared by whoever asked for the session. Not read back from the
      // poller: its record of the intended room is consumed during the launch,
      // before this hook runs, so asking here answers no for every session that
      // actually started.
      connected_to_room: params.connectedToRoom === true,
    });
  });

  sessionService.on('session:runtime-ready', async (sessionId, result) => {
    await rememberSession(sessionId, result.locationId);
  });

  // Only a person deletes or archives a session through the service.
  sessionService.on('session:deleted', (sessionId) => endSession(sessionId, 'person'));
  sessionService.on('session:archived', (sessionId) => endSession(sessionId, 'person'));

  // Un-archiving puts a session that has already reported an end back into use.
  // Forgetting that it ended is what lets it report the next one: the record is
  // there to collapse two endings moments apart, not to retire a session id for
  // the life of the run.
  sessionService.on('session:restored', (sessionId) => {
    endedSessions.delete(sessionId);
  });

  // Rows deleted outside the sessionService path — the sessions of an agent
  // being removed, whether by a person or by a pass pruning one its server no
  // longer has, or of an agent being reset — arrive on the other bus, saying
  // who removed them. Subscribing to only one leaves those sessions reporting
  // a start and never an end.
  sessionHooks.on('session:deleted', (sessionId, removedBy) => endSession(sessionId, removedBy));
}
