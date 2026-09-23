import { sessionSchema } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { getAgentLocation } from '@main/core/agents/agent-location';
import { getAgents } from '@main/core/agents/getAgents';
import { listStoppedControllerAgentIds } from '@main/core/switch-rooms/auto-session-store';
import { controllerConnectionId } from '@main/core/switch-rooms/session-connection-id';
import { fetchRoomHealth } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { redactSecrets } from '@main/lib/file-logger';
import {
  classifyConnection,
  type AgentConnectionHealth,
} from '@shared/core/switch-rooms/connection-health';
import { remoteWatcherStatus } from './diagnostics';
import { localWatcherStatus } from './local-host';

const disconnectedSince = new Map<string, number>();
const healthSchema = z.object({
  associations: z.record(z.string(), z.string()),
  connections: z.record(z.string(), z.array(z.string())),
  sessions: z.array(
    z.union([
      sessionSchema,
      z.object({ sessionId: z.string(), agentId: z.string(), discoveryError: z.string() }),
    ])
  ),
});
export async function connectionHealth(serverId: string) {
  const server = await getServer(serverId);
  if (!server) throw new Error('Switch server not found.');
  const [agents, stopped, remote] = await Promise.all([
    getAgents(),
    listStoppedControllerAgentIds(),
    fetchRoomHealth(server).then((value) => healthSchema.parse(value)),
  ]);
  const health = await Promise.all(
    agents
      .filter((agent) => agent.serverId === serverId && agent.switchAgentId)
      .map(async (agent): Promise<AgentConnectionHealth> => {
        try {
          const location = await getAgentLocation(agent);
          const host = location.sshHost
            ? await remoteWatcherStatus(agent.id)
            : await localWatcherStatus(agent.switchAgentId!);
          const connected =
            remote.connections[agent.switchAgentId!]?.includes(
              controllerConnectionId(agent.switchAgentId!)
            ) ?? false;
          const key = `${serverId}:${agent.id}`;
          if (connected && host?.running) disconnectedSince.delete(key);
          else if (!disconnectedSince.has(key)) disconnectedSince.set(key, Date.now());
          return {
            agentId: agent.id,
            state: classifyConnection({
              stopped: stopped.includes(agent.id),
              running: host?.running ?? false,
              connected,
              takenOver: !!host?.takenOver,
              disconnectedFor: Date.now() - (disconnectedSince.get(key) ?? Date.now()),
            }),
            detail: host?.failure ? redactSecrets(host.failure) : null,
          };
        } catch (error) {
          return { agentId: agent.id, state: 'unknown', detail: redactSecrets(String(error)) };
        }
      })
  );
  return { agents: health, sessions: remote.sessions, associations: remote.associations };
}
