import {
  AgentManagementUnavailableError,
  enrollConsoleController,
  fetchManagedAgents,
  fetchManagementControllers,
  type ManagedAgent,
  type ManagementController,
  managementErrorCode,
  managementErrorMessage,
  revokeManagementController,
  updateManagementController,
} from '@main/core/switch-servers/gateway-client';
import { withReachableWorkspaceSession } from '@main/core/workspaces/workspace-session';
import type { EmbeddedControllerRemote } from '@shared/core/embedded-controller/embedded-controller';
import type { ManagementPort } from './embedded-controller-service';

/** This computer's controller in the server's lists, and the managed agents placed on it. */
export function placedOn(
  controllerId: string,
  controllers: ManagementController[],
  agents: ManagedAgent[]
): Extract<EmbeddedControllerRemote, { kind: 'ok' }> {
  const controller = controllers.find((candidate) => candidate.id === controllerId) ?? null;
  return {
    kind: 'ok',
    controller: controller
      ? {
          name: controller.name,
          description: controller.description,
          state: controller.state,
          lastSeenAt: controller.lastSeenAt,
        }
      : null,
    agents: agents
      .filter((agent) => agent.controllerId === controllerId)
      .map((agent) => ({
        agentId: agent.agentId,
        name: agent.name,
        displayName: agent.displayName,
        provider: agent.provider,
        desiredState: agent.desiredState,
        actual: agent.status,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The management routes, through the signed-in session of the workspace the controller belongs to. */
export const gatewayManagementPort: ManagementPort = {
  enroll: async (workspaceId, body) => {
    try {
      return await withReachableWorkspaceSession(workspaceId, async (server) => {
        const enrolled = await enrollConsoleController(server, body);
        return { serverId: server.id, apiUrl: server.url, ...enrolled };
      });
    } catch (error) {
      if (error instanceof AgentManagementUnavailableError) throw error;
      throw new Error(`Could not add this computer to Switch: ${managementErrorMessage(error)}`, {
        cause: error,
      });
    }
  },

  read: async (workspaceId, controllerId) => {
    try {
      return await withReachableWorkspaceSession(workspaceId, async (server) => {
        const controllers = await fetchManagementControllers(server);
        if (controllerId === null) return { kind: 'ok', controller: null, agents: [] };
        return placedOn(controllerId, controllers, await fetchManagedAgents(server));
      });
    } catch (error) {
      if (error instanceof AgentManagementUnavailableError) return { kind: 'unavailable' };
      return { kind: 'error', message: managementErrorMessage(error) };
    }
  },

  update: async (workspaceId, controllerId, changes) => {
    try {
      await withReachableWorkspaceSession(workspaceId, (server) =>
        updateManagementController(server, controllerId, changes)
      );
    } catch (error) {
      throw new Error(
        `Could not change this computer in Switch: ${managementErrorMessage(error)}`,
        {
          cause: error,
        }
      );
    }
  },

  revoke: async (workspaceId, controllerId) => {
    try {
      await withReachableWorkspaceSession(workspaceId, (server) =>
        revokeManagementController(server, controllerId)
      );
      return 'revoked';
    } catch (error) {
      if (managementErrorCode(error) === 'not_found') return 'already_gone';
      throw new Error(
        `Could not remove this computer from Switch, so it keeps running: ${managementErrorMessage(error)}`,
        { cause: error }
      );
    }
  },
};
