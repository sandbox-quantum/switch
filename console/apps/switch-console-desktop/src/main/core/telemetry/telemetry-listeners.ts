import { agentEvents } from '@main/core/agents/agent-events';
import { getAgentById } from '@main/core/agents/getAgentById';
import { getLocationById } from '@main/core/locations/store';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { sessionService } from '@main/core/sessions/session-service';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { TelemetryEventMap, TelemetryLocationKind } from './events';
import { trackEvent } from './telemetry-service';

type SessionShape = {
  agent_type: AgentProviderId | 'unknown';
  location: TelemetryLocationKind;
};

const UNKNOWN_SESSION: SessionShape = { agent_type: 'unknown', location: 'unknown' };

/**
 * What each live session is, remembered when it starts so its end can be
 * reported without a database read on a path that must stay cheap. A session
 * the app inherited across a restart is not in here, and is reported as
 * `unknown` rather than guessed at.
 */
const liveSessions = new Map<string, SessionShape>();

/**
 * Sessions that have already reported an end. A session whose agent crashed for
 * good and is deleted afterwards has ended once, not twice — without this the
 * same session counts as both a failure and a normal end.
 */
const endedSessions = new Set<string>();

async function locationKindOf(locationId: string): Promise<TelemetryLocationKind> {
  const location = await getLocationById(locationId);
  if (!location) return 'unknown';
  return location.sshHost ? 'remote' : 'local';
}

function endSession(sessionId: string, outcome: TelemetryEventMap['session_ended']['outcome']) {
  if (endedSessions.has(sessionId)) return;
  endedSessions.add(sessionId);

  const shape = liveSessions.get(sessionId) ?? UNKNOWN_SESSION;
  liveSessions.delete(sessionId);
  trackEvent('session_ended', { ...shape, outcome });
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
      agent_type: agent.providerId,
      location: await locationKindOf(agent.locationId),
    });
  });

  sessionService.on('session:created', async (session) => {
    const agent = await getAgentById(session.agentId);
    const shape: SessionShape = {
      agent_type: session.providerId,
      location: agent ? await locationKindOf(agent.locationId) : 'unknown',
    };
    liveSessions.set(session.id, shape);
    trackEvent('session_started', { agent_type: session.providerId, location: shape.location });
  });

  sessionService.on('session:deleted', (sessionId) => endSession(sessionId, 'normal'));
  sessionService.on('session:archived', (sessionId) => endSession(sessionId, 'normal'));

  // Only a decision of `failed` is an ending: the supervisor's other unexpected
  // exits are followed by a respawn, and the session goes on.
  sessionHooks.on('session:agent-exited', ({ sessionId, decision }) => {
    if (decision !== 'failed') return;
    endSession(sessionId, 'failed');
  });
}
