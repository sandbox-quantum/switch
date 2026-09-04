import { events } from '@main/lib/events';
import { agentsChangedChannel } from '@shared/events/appEvents';
import { agentEvents } from './agent-events';

/**
 * Forward agent CRUD from the main-only `agentEvents` bus to the renderer, so
 * renderer stores and queries can react to create/update/delete without each
 * mutating call site refetching by hand.
 */
export function bridgeAgentEventsToRenderer(): void {
  agentEvents.on('agent:created', () => events.emit(agentsChangedChannel, { kind: 'created' }));
  agentEvents.on('agent:updated', () => events.emit(agentsChangedChannel, { kind: 'updated' }));
  agentEvents.on('agent:deleted', () => events.emit(agentsChangedChannel, { kind: 'deleted' }));
}
