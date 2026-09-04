import { events } from '@main/lib/events';
import { agentsChangedChannel } from '@shared/events/appEvents';
import { agentEvents } from './agent-events';

/**
 * Forward agent CRUD from the main-only `agentEvents` bus to the renderer
 * (CHOO-2560). Without this, every renderer surface that lists agents has to
 * remember to refetch after each mutating call — a burden that has already
 * produced two stale-view bugs (the sidebar after Load, the Load section
 * after Remove).
 */
export function bridgeAgentEventsToRenderer(): void {
  agentEvents.on('agent:created', () => events.emit(agentsChangedChannel, { kind: 'created' }));
  agentEvents.on('agent:updated', () => events.emit(agentsChangedChannel, { kind: 'updated' }));
  agentEvents.on('agent:deleted', () => events.emit(agentsChangedChannel, { kind: 'deleted' }));
}
