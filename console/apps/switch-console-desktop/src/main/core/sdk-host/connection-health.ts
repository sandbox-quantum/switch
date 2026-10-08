import { listManagedAgentRecords } from '@main/core/agent-migration/managed-agents-store';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgents } from '@main/core/agents/getAgents';
import { listStoppedControllerAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { getServer } from '@main/core/switch-servers/servers-store';
import { events } from '@main/lib/events';
import { redactSecrets } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import { roomHealthChangedChannel } from '@shared/core/switch-rooms/switchRoomEvents';
import { ConnectionHealthMonitor } from './connection-health-monitor';
import { hostWatcherStatus } from './host-watcher-snapshot';
import { localWatcherControl } from './local-host';

/** How often each remote agent's host is read for its watchers' state. */
const REMOTE_POLL_MS = 5_000;

const monitor = new ConnectionHealthMonitor({
  // A moved agent's Console watcher is off by design: its controller runs it,
  // so it is not this Console's connection to report on.
  linkedAgents: async (serverId) => {
    if (!(await getServer(serverId))) throw new Error('Switch server not found.');
    const moved = new Set((await listManagedAgentRecords()).map((record) => record.agentId));
    return (await getAgents()).flatMap((agent) =>
      agent.serverId === serverId && agent.switchAgentId && !moved.has(agent.id)
        ? [
            {
              id: agent.id,
              serverId,
              switchAgentId: agent.switchAgentId,
              locationId: agent.locationId,
            },
          ]
        : []
    );
  },
  isRemote: async (agent) => !!(await getAgentLocation(agent)).sshHost,
  stoppedAgentIds: listStoppedControllerAgentIds,
  local: localWatcherControl,
  remoteWatcher: hostWatcherStatus,
  emit: (serverId, snapshot) => events.emit(roomHealthChangedChannel, snapshot, serverId),
  redact: redactSecrets,
  logError: (message, context) => log.error(message, context),
  now: () => Date.now(),
  pollMs: REMOTE_POLL_MS,
});

/**
 * The server's agents' room connections and session placements, from their
 * room watchers. Later changes follow on `roomHealthChangedChannel` with the
 * server id as the topic.
 */
export function connectionHealth(serverId: string) {
  return monitor.snapshot(serverId);
}

/**
 * One linked agent's session placements, session id → room id, from its room
 * watcher; null while the watcher cannot be asked.
 */
export async function agentPlacements(
  serverId: string,
  agentId: string
): Promise<Record<string, string> | null> {
  await monitor.snapshot(serverId);
  return monitor.placementsOf(agentId);
}
