import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { registerLogContextResolver } from './log-context';
import { lookupAgentName, lookupSessionTitle } from './log-name-cache';

/**
 * Teach the log sink how to expand the ids an entry already carries.
 *
 * Call sites thread at most a session id — everything else is derived here, in
 * one place, so no intermediate function has to forward fields it does not
 * otherwise use.
 */
export function registerLogEnrichment(): void {
  // A live session already knows its room and agent; this costs a map lookup.
  registerLogContextResolver((context) => {
    if (!context.sessionId) return undefined;
    return switchRoomService.describeSessionForLog(context.sessionId);
  });

  // Names for whichever ids ended up on the entry, including ids the resolver
  // above just derived.
  registerLogContextResolver((context) => ({
    sessionTitle: lookupSessionTitle(context.sessionId),
    agentName: lookupAgentName(context.agentId),
  }));
}
