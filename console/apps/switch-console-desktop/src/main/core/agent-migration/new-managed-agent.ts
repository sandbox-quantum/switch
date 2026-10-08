import {
  AgentManagementUnavailableError,
  createManagedAgent,
  fetchManagementControllers,
  GatewayError,
  managementErrorMessage,
} from '@main/core/switch-servers/gateway-client';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import { resolveMachine } from './agent-migration';
import { NewManagedAgentService } from './new-managed-agent-service';

export const newManagedAgentService = new NewManagedAgentService({
  workspaceFor: async (serverId) => (await requireWorkspaceForServer(serverId)).id,
  machine: resolveMachine,
  managementAvailable: (workspaceId) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      try {
        await fetchManagementControllers(server);
        return true;
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return false;
        throw error;
      }
    }),
  create: (workspaceId, body) =>
    withReachableWorkspaceSession(workspaceId, async (server) => {
      try {
        return { kind: 'created', switchAgentId: await createManagedAgent(server, body) };
      } catch (error) {
        if (error instanceof GatewayError && error.status === 409) return { kind: 'name-conflict' };
        if (error instanceof GatewayError && error.status !== undefined && error.status < 500)
          return { kind: 'refused', message: managementErrorMessage(error) };
        throw error;
      }
    }),
  log: {
    info: (message, fields) => log.info(message, { event: 'new_managed_agent', ...fields }),
    warn: (message, fields) => log.warn(message, { event: 'new_managed_agent', ...fields }),
    error: (message, fields) => log.error(message, { event: 'new_managed_agent', ...fields }),
  },
});
