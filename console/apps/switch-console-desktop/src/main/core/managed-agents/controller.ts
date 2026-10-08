import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import {
  AgentManagementUnavailableError,
  deleteAgent,
  deleteManagedAgent,
  fetchAdvancedConfigSchema,
  fetchManagedAgents,
  fetchManagementControllers,
  GatewayError,
  managementErrorMessage,
  setManagedAgentDesiredState,
  updateManagedAgent,
} from '@main/core/switch-servers/gateway-client';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
  ManagedMachine,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { ownedMachines } from './owned-machines';

/**
 * The signed-in user's managed agents on a server, as the server holds them:
 * every one, whatever machine it runs on. Console keeps no copy.
 */
export const managedAgentsController = createRPCController({
  /** Null when the server does not run agent management. */
  list: async (serverId: string): Promise<ManagedAgentView[] | null> => {
    const workspace = await requireWorkspaceForServer(serverId);
    return withReachableServerWorkspaceSession(serverId, async (server) => {
      let agents;
      let machines = new Map<string, ManagedMachine>();
      try {
        agents = await fetchManagedAgents(server);
        // A server that does not send each agent's machine with it is asked for its machines.
        if (agents.some((agent) => agent.machine === undefined))
          machines = new Map(
            (await fetchManagementControllers(server)).map((controller) => [
              controller.id,
              controller,
            ])
          );
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return null;
        throw error;
      }
      return agents.map((agent): ManagedAgentView => {
        const machine =
          agent.machine !== undefined
            ? agent.machine
            : agent.controllerId
              ? machines.get(agent.controllerId)
              : undefined;
        return {
          serverId,
          workspaceId: workspace.id,
          agentId: agent.agentId,
          name: agent.name,
          displayName: agent.displayName,
          iconUrl: agent.iconUrl,
          description: agent.description,
          machine: machine
            ? { id: machine.id, name: machine.name, kind: machine.kind, state: machine.state }
            : null,
          desiredState: agent.desiredState,
          revision: agent.revision,
          definition: {
            provider: agent.provider,
            model: agent.model,
            advancedConfig: agent.advancedConfig,
            instructions: agent.instructions,
            autoApprove: agent.autoApprove,
            directory: agent.directory,
            isolation: agent.isolation,
          },
          status: agent.status,
        };
      });
    });
  },

  /**
   * The owner's machines an agent can be placed on, with the providers each
   * last reported. Null when the server does not run agent management.
   */
  machines: async (serverId: string): Promise<OwnedMachine[] | null> => {
    const [thisComputer, hosts] = await Promise.all([
      embeddedControllerService.enrolledControllerId(serverId),
      hostControllerService.recordsOn(serverId),
    ]);
    return withReachableServerWorkspaceSession(serverId, async (server) => {
      let controllers;
      try {
        controllers = await fetchManagementControllers(server);
      } catch (error) {
        if (error instanceof AgentManagementUnavailableError) return null;
        throw error;
      }
      return ownedMachines(controllers, {
        thisComputer,
        sshHosts: hosts.map(({ controllerId, sshHost }) => ({ controllerId, sshHost })),
      });
    });
  },

  /** Each provider's advanced configuration fields, keyed by provider, as the server checks a definition against them. */
  advancedConfigSchema: (serverId: string): Promise<Record<string, AdvancedConfigField[]>> =>
    withReachableServerWorkspaceSession(serverId, (server) => fetchAdvancedConfigSchema(server)),

  /** Changes its settings on the server; Switch refuses a change its machine cannot run, in its own words. */
  update: (params: {
    serverId: string;
    agentId: string;
    changes: ManagedAgentChanges;
  }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      const definition = definitionBody(params.changes.definition);
      try {
        await updateManagedAgent(server, params.agentId, {
          definition: Object.keys(definition).length > 0 ? definition : null,
          ...(params.changes.machineId !== undefined
            ? { controllerId: params.changes.machineId }
            : {}),
        });
      } catch (error) {
        if (error instanceof GatewayError && error.status !== undefined && error.status < 500)
          throw new Error(managementErrorMessage(error));
        throw error;
      }
    }),

  /** Starts or stops it on its machine. */
  setDesiredState: (params: {
    serverId: string;
    agentId: string;
    desiredState: 'running' | 'stopped';
  }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      setManagedAgentDesiredState(server, params.agentId, params.desiredState)
    ),

  /** Deletes the agent: its machine stops it, and it is gone from Switch. */
  remove: (params: { serverId: string; agentId: string }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      await deleteManagedAgent(server, params.agentId);
      await deleteAgent(server, params.agentId);
    }),
});

function definitionBody(changes: ManagedAgentChanges['definition']): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (changes.provider !== undefined) body.provider = changes.provider;
  if (changes.model !== undefined) body.model = changes.model;
  if (changes.advancedConfig !== undefined) body.advanced_config = changes.advancedConfig;
  if (changes.instructions !== undefined) body.instructions = changes.instructions;
  if (changes.autoApprove !== undefined) body.auto_approve = changes.autoApprove;
  if (changes.directory !== undefined) body.directory = changes.directory;
  if (changes.isolation !== undefined) body.isolation = changes.isolation;
  return body;
}
