import {
  parseGoogleCredentials,
  type ProviderLogin,
  sealingKeyId,
  sealProviderLogin,
  vertexLoginCredential,
} from '@switch-console/agent-providers';
import { agentMigrationService } from '@main/core/agent-migration/agent-migration';
import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import {
  AgentManagementUnavailableError,
  deleteAgent,
  fetchAdvancedConfigSchema,
  fetchManagedAgents,
  fetchMachineOperation,
  fetchManagementControllers,
  GatewayError,
  giveMachineLogin,
  issueMachineEnrollment,
  recheckMachineProvider,
  type ManagementController,
  managementErrorMessage,
  revokeManagementController,
  setManagedAgentDesiredState,
  updateManagedAgent,
  updateManagementController,
} from '@main/core/switch-servers/gateway-client';
import {
  localGoogleCredentialsPath,
  readLocalGoogleCredentials,
} from '@main/core/switch-servers/local-google-sign-in';
import {
  localProviderAuthPath,
  readLocalProviderSignIn,
} from '@main/core/switch-servers/local-provider-sign-in';
import { withReachableServerWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { log } from '@main/lib/logger';
import type { MachineEnrollment } from '@shared/core/managed-agents/machine-enrollment';
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
  MachineLoginInput,
  MachineDetail,
  MachineLoginOutcome,
  ManagedMachine,
  OwnedMachine,
  ThisComputerReport,
} from '@shared/core/managed-agents/managed-agents';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { isLoopbackUrl } from '@shared/core/switch-servers/loopback';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import {
  type LocalControllers,
  machineDetails,
  ownedMachines,
  preferredFirst,
  thisComputerReport,
} from './owned-machines';

/** The owner's controllers on a server, as `view` makes them; null without agent management. */
async function controllersOn<T>(
  serverId: string,
  view: (controllers: ManagementController[], local: LocalControllers) => T
): Promise<T | null> {
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
    return view(controllers, {
      thisComputer,
      sshHosts: hosts.map(({ controllerId, sshHost }) => ({ controllerId, sshHost })),
    });
  });
}

function machinesOn(serverId: string): Promise<OwnedMachine[] | null> {
  return controllersOn(serverId, ownedMachines);
}

/** Runs a management call, giving a refusal Switch explains (a 4xx) in Switch's own words. */
async function inSwitchsWords<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof GatewayError && error.status !== undefined && error.status < 500)
      throw new Error(managementErrorMessage(error));
    throw error;
  }
}

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
          ...(agent.template !== undefined ? { template: agent.template } : {}),
          definition: {
            provider: agent.provider,
            model: agent.model,
            advancedConfig: agent.advancedConfig,
            instructions: agent.instructions,
            autoMode: agent.autoMode,
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
  machines: (serverId: string): Promise<OwnedMachine[] | null> => machinesOn(serverId),

  /**
   * Every one of the owner's machines on a server, revoked ones included, with
   * all each last reported, for the Machines page. Null when the server does
   * not run agent management.
   */
  machineDetails: (serverId: string): Promise<MachineDetail[] | null> =>
    controllersOn(serverId, machineDetails),

  /**
   * This computer's providers as its controller last reported them to a
   * server it runs for, `preferServerId` (the one Console is on now) first
   * when it is one; null when it runs for none, or none has a report, and
   * Console's own check is what there is to go by.
   */
  thisComputerProviders: async (
    preferServerId: string | null = null
  ): Promise<ThisComputerReport | null> =>
    thisComputerReport(
      preferredFirst(await embeddedControllerService.runningServerIds(), preferServerId),
      machinesOn
    ),

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
      if (!controller) throw new Error('That device is not one of yours on this server.');
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

  /**
   * A one-time code to enroll a new machine with, and the address it enrolls
   * against: the one the server names, else the one Console reaches it at,
   * which `fallback` discloses. `loopback` says that address only works on
   * this computer.
   */
  machineEnrollment: (serverId: string): Promise<MachineEnrollment> =>
    withReachableServerWorkspaceSession(serverId, async (server) => {
      const issued = await issueMachineEnrollment(server);
      // A server with GATEWAY_PUBLIC_URL set but empty names "" rather than null.
      const named = issued.serverUrl?.trim() || null;
      const serverUrl = named ?? server.url;
      return {
        code: issued.code,
        expiresAt: issued.expiresAt,
        serverUrl,
        loopback: isLoopbackUrl(serverUrl),
        fallback: named === null,
      };
    }),

  /** How the machine took up a login given to it, by the operation `giveMachineLogin` answered. */
  machineLoginOutcome: (params: {
    serverId: string;
    machineId: string;
    operationId: string;
  }): Promise<MachineLoginOutcome> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      machineOperationOutcome(server, params.machineId, params.operationId, 'take the login up')
    ),

  /**
   * Has one of the owner's machines check a provider's install and sign-in
   * again. Answers the operation; `machineRecheckOutcome` says how it went,
   * and the machine's next report carries what it found.
   */
  recheckMachineProvider: (params: {
    serverId: string;
    machineId: string;
    provider: AgentProviderId;
  }): Promise<{ operationId: string }> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      recheckMachineProvider(server, params.machineId, params.provider)
    ),

  /**
   * Renames one of the owner's machines and/or changes its description;
   * `description: null` clears it. Switch refuses a name it does not take,
   * in its own words.
   */
  updateMachine: (params: {
    serverId: string;
    machineId: string;
    changes: { name?: string; description?: string | null };
  }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      inSwitchsWords(() => updateManagementController(server, params.machineId, params.changes))
    ),

  /**
   * Removes one of the owner's machines from Switch: its credential is
   * deleted and it cannot reconnect. The agents placed on it stay placed on
   * it, and do not run until they are moved.
   */
  removeMachine: (params: { serverId: string; machineId: string }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      inSwitchsWords(() => revokeManagementController(server, params.machineId))
    ),

  /** How a recheck went, by the operation `recheckMachineProvider` answered. */
  machineRecheckOutcome: (params: {
    serverId: string;
    machineId: string;
    operationId: string;
  }): Promise<MachineLoginOutcome> =>
    withReachableServerWorkspaceSession(params.serverId, (server) =>
      machineOperationOutcome(server, params.machineId, params.operationId, 'check the provider')
    ),

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
      await inSwitchsWords(() =>
        updateManagedAgent(server, params.agentId, {
          definition: Object.keys(definition).length > 0 ? definition : null,
          ...(params.changes.machineId !== undefined
            ? { controllerId: params.changes.machineId }
            : {}),
        })
      );
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

  /** Deletes the agent: its machine stops it, and it is gone from Switch.
   * One call: Switch stops managing an agent it deletes, while stopping
   * managing it first would leave the agent behind if the delete then failed.
   * An agent this Console moved to managed also loses the Console row it was
   * moved from; a failure there is left to the next automatic pass. */
  remove: async (params: { serverId: string; agentId: string }): Promise<void> => {
    await withReachableServerWorkspaceSession(params.serverId, (server) =>
      deleteAgent(server, params.agentId)
    );
    await agentMigrationService
      .forgetDeleted(params.serverId, params.agentId)
      .catch((error: unknown) => {
        log.error('Could not remove the Console agent a deleted managed agent was moved from', {
          serverId: params.serverId,
          agentId: params.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  },
});

function definitionBody(changes: ManagedAgentChanges['definition']): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (changes.provider !== undefined) body.provider = changes.provider;
  if (changes.model !== undefined) body.model = changes.model;
  if (changes.advancedConfig !== undefined) body.advanced_config = changes.advancedConfig;
  if (changes.instructions !== undefined) body.instructions = changes.instructions;
  if (changes.autoMode !== undefined) body.auto_mode = changes.autoMode;
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
  if (input.source === 'vertex') {
    if (provider !== 'claude') throw new Error('Only Claude signs in through Vertex AI.');
    const text =
      input.credentials.from === 'key'
        ? input.credentials.json.trim()
        : await readLocalGoogleCredentials(localGoogleCredentialsPath());
    if (!text) throw new Error('Paste the service account key, or pick its JSON file.');
    const credential = vertexLoginCredential({
      project: input.project,
      region: input.region,
      credentials: parseGoogleCredentials(text),
    });
    if (credential.length > 16384) throw new Error('The Google credential is too large to give.');
    return { kind: 'vertex', credential };
  }
  if (input.source === 'typed') {
    const credential = input.credential.trim();
    if (!credential) throw new Error('Enter the key or token to give the device.');
    if (input.kind === 'setup-token' && provider !== 'claude')
      throw new Error('Only Claude takes a setup token.');
    return { kind: input.kind, credential };
  }
  if (provider !== 'codex' && provider !== 'opencode' && provider !== 'antigravity')
    throw new Error(
      `This computer's ${provider} sign-in cannot be given to another device; give it an API key or token.`
    );
  const credential = await readLocalProviderSignIn(provider, localProviderAuthPath(provider));
  if (!credential)
    throw new Error(
      provider === 'codex'
        ? 'This computer is not signed in to codex. Sign in here first. If Codex says you are ' +
            'already signed in, its login is likely in the OS keyring, which cannot be given to ' +
            'another device: unless your organization enforces the keyring, set ' +
            'cli_auth_credentials_store = "file" in the Codex config.toml and sign in again.'
        : provider === 'antigravity'
          ? 'This computer has no Antigravity sign-in to give. Google’s agy keeps its sign-in ' +
            'in the OS keychain, which cannot be given to another device: sign in there with ' +
            'agy acp --login instead.'
          : `This computer is not signed in to ${provider}. Sign in here first.`
    );
  return { kind: 'auth-json', credential };
}

/**
 * Where one of a machine's operations stands: still pending, done, or why it
 * failed. `what` finishes "The machine did not …" for the failures the
 * server gives no words for.
 */
async function machineOperationOutcome(
  server: SwitchServer,
  machineId: string,
  operationId: string,
  what: string
): Promise<MachineLoginOutcome> {
  const operation = await fetchMachineOperation(server, machineId, operationId);
  if (!operation) return { state: 'pending' };
  if (operation.state === 'succeeded') return { state: 'succeeded' };
  if (operation.state === 'pending' || operation.state === 'claimed') return { state: 'pending' };
  return {
    state: 'failed',
    code: operation.error?.code ?? operation.state,
    message:
      operation.error?.message ??
      (operation.state === 'expired'
        ? `The device did not ${what} in time; is it online?`
        : `The device did not ${what} (${operation.state}).`),
  };
}
