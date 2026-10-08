import {
  type ProviderLogin,
  sealingKeyId,
  sealProviderLogin,
} from '@switch-console/agent-providers';
import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import {
  AgentManagementUnavailableError,
  deleteAgent,
  deleteManagedAgent,
  fetchAdvancedConfigSchema,
  fetchManagedAgents,
  fetchMachineOperation,
  fetchManagementControllers,
  GatewayError,
  giveMachineLogin,
  managementErrorMessage,
  setManagedAgentDesiredState,
  updateManagedAgent,
} from '@main/core/switch-servers/gateway-client';
import {
  localProviderAuthPath,
  readLocalProviderSignIn,
} from '@main/core/switch-servers/local-provider-sign-in';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
  MachineLoginInput,
  MachineLoginOutcome,
  ManagedMachine,
  OwnedMachine,
} from '@shared/core/managed-agents/managed-agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
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

  /**
   * Gives one of the owner's machines a provider login, sealed here to the
   * machine's own key so the server only ever holds ciphertext. Answers the
   * operation the machine takes it up with; `machineLoginOutcome` says how
   * that went.
   */
  giveMachineLogin: (params: {
    serverId: string;
    machineId: string;
    provider: AgentProviderId;
    login: MachineLoginInput;
  }): Promise<{ operationId: string }> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      const controller = (await fetchManagementControllers(server)).find(
        (candidate) => candidate.id === params.machineId
      );
      if (!controller) throw new Error('That machine is not one of yours on this server.');
      if (!controller.sealingKey)
        throw new Error(
          `${controller.name} cannot be given a login: its controller has no key for one. Update the controller on it.`
        );
      if (sealingKeyId(controller.sealingKey.key) !== controller.sealingKey.keyId)
        throw new Error(`The server sent a key for ${controller.name} that does not match its id.`);
      const login = await loginToGive(params.provider, params.login);
      const { operationId } = await giveMachineLogin(
        server,
        controller.id,
        params.provider,
        sealProviderLogin({
          publicKey: controller.sealingKey.key,
          controllerId: controller.id,
          provider: params.provider,
          login,
        })
      );
      return { operationId };
    }),

  /** How the machine took up a login given to it, by the operation `giveMachineLogin` answered. */
  machineLoginOutcome: (params: {
    serverId: string;
    machineId: string;
    operationId: string;
  }): Promise<MachineLoginOutcome> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      const operation = await fetchMachineOperation(server, params.machineId, params.operationId);
      if (!operation) return { state: 'pending' };
      if (operation.state === 'succeeded') return { state: 'succeeded' };
      if (operation.state === 'pending' || operation.state === 'claimed')
        return { state: 'pending' };
      return {
        state: 'failed',
        code: operation.error?.code ?? operation.state,
        message:
          operation.error?.message ??
          (operation.state === 'expired'
            ? 'The machine did not take the login up in time; is it online?'
            : `The machine did not take the login up (${operation.state}).`),
      };
    }),

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

/** The login a machine is given, from what was typed or this computer's own sign-in. */
async function loginToGive(
  provider: AgentProviderId,
  input: MachineLoginInput
): Promise<ProviderLogin> {
  if (input.source === 'typed') {
    const credential = input.credential.trim();
    if (!credential) throw new Error('Enter the key or token to give the machine.');
    if (input.kind === 'setup-token' && provider !== 'claude')
      throw new Error('Only Claude takes a setup token.');
    return { kind: input.kind, credential };
  }
  if (provider !== 'codex' && provider !== 'opencode' && provider !== 'antigravity')
    throw new Error(
      `This computer's ${provider} sign-in cannot be given to another machine; give it an API key or token.`
    );
  const credential = await readLocalProviderSignIn(provider, localProviderAuthPath(provider));
  if (!credential)
    throw new Error(`This computer is not signed in to ${provider}. Sign in here first.`);
  return { kind: 'auth-json', credential };
}
