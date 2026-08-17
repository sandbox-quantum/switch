import { agentEvents } from '@main/core/agents/agent-events';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getLocationById } from '@main/core/locations/store';
import { getSession } from '@main/core/sessions/operations/getSession';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import {
  isValidProviderId,
  type AgentProviderId,
} from '@shared/core/providers/agent-provider-registry';
import type { TelemetryEventMap, TelemetryLocationKind } from './events';
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

/** A provider id straight from the database is typed, not validated. */
function agentTypeOf(providerId: string): AgentProviderId | 'unknown' {
  return isValidProviderId(providerId) ? providerId : 'unknown';
}

async function locationKindOf(locationId: string): Promise<TelemetryLocationKind> {
  const location = await getLocationById(locationId);
  if (!location) return 'unknown';
  return location.sshHost ? 'remote' : 'local';
}

function rememberEnded(sessionId: string): void {
  endedSessions.add(sessionId);
  if (endedSessions.size <= ENDED_SESSION_MEMORY) return;

  const oldest = endedSessions.values().next();
  if (!oldest.done) endedSessions.delete(oldest.value);
}

function endSession(sessionId: string, outcome: TelemetryEventMap['session_ended']['outcome']) {
  if (endedSessions.has(sessionId)) return;
  rememberEnded(sessionId);

  const shape = liveSessions.get(sessionId) ?? UNKNOWN_SESSION;
  liveSessions.delete(sessionId);
  trackEvent('session_ended', { ...shape, outcome });
}

/**
 * Learn what a session is without reporting it as a new one.
 *
 * A session that outlives a restart is provisioned again rather than created,
 * so this run never sees it start. Recording it here is what stops its eventual
 * end being filed under `unknown` — which, since restoring live sessions is
 * routine, would otherwise be most of the ends the app ever reports.
 */
async function rememberSession(sessionId: string, locationId: string): Promise<void> {
  if (liveSessions.has(sessionId)) return;

  const session = await getSession(sessionId);
  if (!session) return;

  liveSessions.set(sessionId, {
    agent_type: agentTypeOf(session.providerId),
    location: await locationKindOf(locationId),
  });
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
  agentEvents.on('agent:created', async (agent) => {
    trackEvent('agent_created', {
      agent_type: agentTypeOf(agent.providerId),
      location: await locationKindOf(agent.locationId),
    });
  });

  sessionService.on('session:created', async (session) => {
    const agent = await getAgentById(session.agentId);
    const shape: SessionShape = {
      agent_type: agentTypeOf(session.providerId),
      location: agent ? await locationKindOf(agent.locationId) : 'unknown',
    };
    liveSessions.set(session.id, shape);
    trackEvent('session_started', shape);
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
