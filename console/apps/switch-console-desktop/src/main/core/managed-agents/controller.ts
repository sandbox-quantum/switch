import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  parseGoogleCredentials,
  type ProviderLogin,
  sealingKeyId,
  sealProviderLogin,
  vertexLoginCredential,
} from '@switch-console/agent-providers';
import { app } from 'electron';
import { agentMigrationService } from '@main/core/agent-migration/agent-migration';
import { embeddedControllerService } from '@main/core/embedded-controller/embedded-controllers';
import { hostControllerService } from '@main/core/host-controllers/host-controllers';
import { deleteMindingBoxLogin } from '@main/core/managed-agents/cloud-delete';
import { hostedV2On } from '@main/core/shared-cloud/hosted-v2';
import { MOCK_BOX, sharedCloudMock } from '@main/core/shared-cloud/shared-cloud-client';
import {
  AgentManagementUnavailableError,
  deleteAgent,
  fetchAdvancedConfigSchema,
  fetchMachineLoginProviders,
  fetchManagedAgents,
  fetchMachineOperation,
  fetchManagementControllers,
  GatewayError,
  giveMachineLogin,
  listCloudMachines,
  managementErrorCode,
  managementErrorMessage,
  repairController,
  setManagedAgentDesiredState,
  updateManagedAgent,
  withdrawMachineLogin,
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
import type {
  AdvancedConfigField,
  ManagedAgentChanges,
  ManagedAgentView,
  MachineLoginInput,
  MachineLoginOutcome,
  ManagedMachine,
  OwnedMachine,
  ThisComputerReport,
} from '@shared/core/managed-agents/managed-agents';
import {
  accountLabelOf,
  type LoginSourceRecord,
  type LoginSourceView,
  REPAIR_FAILED,
  RESEAL_WINDOW_MS,
  type ResealResult,
  repairRefusal,
  resealPlan,
} from '@shared/core/managed-agents/repair';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { ownedMachines, preferredFirst, thisComputerReport } from './owned-machines';
import { RepairNotes } from './repair-notes';

/** V3b: where each machine's login came from, and this Console's Repair presses. */
const repairNotes = new RepairNotes(() =>
  join(app.getPath('userData'), 'managed-agents', 'repair-notes.json')
);
/** V3b: at most one automatic copy per controller and provider for each run of Console. */
const resealTried = new Set<string>();

async function machinesOn(serverId: string): Promise<OwnedMachine[] | null> {
  const machines = await realMachinesOn(serverId);
  if (!sharedCloudMock() || machines === null) return machines;
  return [
    ...machines,
    {
      ...MOCK_BOX,
      providers: [
        { provider: 'claude', ready: true, problem: null, detail: null, loginHelps: true },
      ],
      acceptsLogins: false,
      cloud: false,
      workspacesDir: null,
      os: 'linux',
      local: null,
    },
  ];
}

async function realMachinesOn(serverId: string): Promise<OwnedMachine[] | null> {
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
          // Buddy runs on this computer, not in a box, in the mock as in life.
          machine:
            sharedCloudMock() && !agent.name.startsWith('switch-buddy')
              ? MOCK_BOX
              : machine
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
          stopReason: agent.stopReason ?? null,
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
      const controllers = await fetchManagementControllers(server);
      const controller = controllers.find((candidate) => candidate.id === params.machineId);
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
      // V3b: remember only which kind of login this was, for a repair's re-seal. A note that can't be
      // written costs a later ask, never the login just given. Hosted agents v2 only: off, nothing is
      // written, as upstream.
      if (await hostedV2On(server))
        await repairNotes
          .setSource(
            controller.id,
            params.provider,
            sourceRecordFor(params.provider, params.login, login)
          )
          .then(() =>
            repairNotes.prune(liveControllerIds(controllers), Date.now(), RESEAL_WINDOW_MS)
          )
          .catch(() => {});
      return { operationId };
    }),

  /**
   * V3b: the owner repairs their cloud box, whose controller Core sees failing to sign in. Refusals
   * come back as fixed lines, never the server's text. On success this Console notes the press, with
   * the revoked controller and Core's own time for it, so it may copy the login to the box's next
   * controller by itself (`resealAfterRepair`).
   */
  repairCloud: (params: {
    serverId: string;
    machineId: string;
    controllerId: string;
  }): Promise<void> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      // Hosted agents v2 only: off, there is no box to repair.
      if (!(await hostedV2On(server))) throw new Error(repairRefusal(404, null));
      // The press is tied to its machine (security): the owner's own summary must name this
      // controller for this machine, or a mismatch could copy one machine's login kind to another.
      const machine = (await listCloudMachines(server).catch(() => null))?.find(
        (candidate) => candidate.machine_id === params.machineId
      );
      if (!machine || machine.controller_id !== params.controllerId)
        throw new Error(repairRefusal(404, null));
      try {
        await repairController(server, params.controllerId);
      } catch (error) {
        if (error instanceof GatewayError)
          throw new Error(repairRefusal(error.status, managementErrorCode(error)));
        throw new Error(REPAIR_FAILED);
      }
      const pressedAt = Date.now();
      const revoked = (await fetchManagementControllers(server).catch(() => [])).find(
        (candidate) => candidate.id === params.controllerId
      );
      await repairNotes
        .setPress(params.machineId, {
          revokedControllerId: params.controllerId,
          // Without Core's own time for the revocation nothing can be shown to be newer, so this
          // press then only ever asks.
          revokedAt: revoked?.revokedAt ?? null,
          pressedAt,
          copiedControllerId: null,
        })
        .catch(() => {});
    }),

  /** V3b: for the Repair dialog, whether each provider's login on this machine came from this computer. */
  loginSources: async (params: {
    controllerId: string;
  }): Promise<Record<string, LoginSourceView>> => {
    const sources = await repairNotes.sources(params.controllerId).catch(() => ({}));
    const views: Record<string, LoginSourceView> = {};
    for (const [provider, record] of Object.entries(sources)) {
      if (record.source !== 'this-computer' && record.source !== 'vertex-this-computer') {
        views[provider] = { kind: 'typed' };
        continue;
      }
      // The label comes from this computer's own provider file, read here in the main process,
      // never from the server; only a plain e-mail address leaves this function (security).
      const label =
        // Only Codex's file names an account, so only Codex's is read.
        record.source === 'this-computer' && provider === 'codex'
          ? await readLocalProviderSignIn(provider, localProviderAuthPath(provider))
              .then((credential) => (credential ? accountLabelOf(provider, credential) : undefined))
              .catch(() => undefined)
          : undefined;
      views[provider] = label ? { kind: 'this-computer', label } : { kind: 'this-computer' };
    }
    return views;
  },

  /**
   * V3b: after a repair, seals each login the box's new controller asks for (`reseal_providers`) to its
   * own key, by itself where design v1.2 allows it, and says which ones the owner must give again.
   * The main process re-reads the owner's machine and controllers itself; the renderer passes no
   * login and chooses nothing.
   */
  resealAfterRepair: (params: { serverId: string; machineId: string }): Promise<ResealResult> =>
    withReachableServerWorkspaceSession(params.serverId, async (server) => {
      // Hosted agents v2 only: off, nothing is copied or asked.
      if (!(await hostedV2On(server))) return { copied: [], asked: [] };
      const machine = (await listCloudMachines(server))?.find(
        (candidate) => candidate.machine_id === params.machineId
      );
      const providers = machine?.reseal_providers ?? [];
      if (!machine?.controller_id || providers.length === 0) return { copied: [], asked: [] };
      const controllers = await fetchManagementControllers(server);
      const controller = controllers.find((candidate) => candidate.id === machine.controller_id);
      const now = Date.now();
      const press = await repairNotes.press(machine.machine_id).catch(() => null);
      const sources: Record<string, LoginSourceRecord> = press
        ? await repairNotes
            .sources(press.revokedControllerId)
            .catch((): Record<string, LoginSourceRecord> => ({}))
        : {};
      const keyMatches =
        controller?.sealingKey != null &&
        sealingKeyId(controller.sealingKey.key) === controller.sealingKey.keyId;
      const plan =
        controller && controller.revokedAt === null && keyMatches
          ? resealPlan({
              now,
              press,
              controller: { id: controller.id, createdAt: controller.createdAt ?? null },
              providers,
              source: (provider) => sources[provider] ?? null,
            })
          : providers.map((provider) => ({ provider, action: 'ask' as const }));
      const copied: string[] = [];
      const asked: string[] = [];
      for (const { provider, action } of plan) {
        const attempt = `${controller?.id}:${provider}`;
        const record = sources[provider];
        if (action === 'ask' || !controller?.sealingKey || !record || resealTried.has(attempt)) {
          asked.push(provider);
          continue;
        }
        resealTried.add(attempt);
        // The first new controller takes the press before anything is sent; a later one is asked.
        if (!(await repairNotes.claimPress(machine.machine_id, controller.id).catch(() => false))) {
          asked.push(provider);
          continue;
        }
        try {
          const input: MachineLoginInput =
            record.source === 'vertex-this-computer'
              ? {
                  source: 'vertex',
                  project: record.project ?? '',
                  region: record.region ?? '',
                  credentials: { from: 'this-computer' },
                }
              : { source: 'this-computer' };
          const login = await loginToGive(provider as AgentProviderId, input);
          // The sign-in here must name the same account as the record, including naming none:
          // a record with no account and a sign-in that now names one is asked for (QA).
          if (accountHashOf(provider, login) !== record.accountHash) {
            asked.push(provider);
            continue;
          }
          await giveMachineLogin(
            server,
            controller.id,
            provider,
            sealProviderLogin({
              publicKey: controller.sealingKey.key,
              controllerId: controller.id,
              provider: provider as AgentProviderId,
              login,
            })
          );
          await repairNotes.setSource(controller.id, provider, record).catch(() => {});
          copied.push(provider);
        } catch {
          asked.push(provider);
        }
      }
      await repairNotes
        .prune(liveControllerIds(controllers), now, RESEAL_WINDOW_MS)
        .catch(() => {});
      // Counts and fixed words only: never a login, a key, a path or the server's text.
      log.info('Repair re-seal', {
        event: 'repair_reseal',
        copied: copied.length,
        asked: asked.length,
      });
      return { copied, asked };
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

  /** Deletes the agent: its machine stops it, and it is gone from Switch.
   * One call: Switch stops managing an agent it deletes, while stopping
   * managing it first would leave the agent behind if the delete then failed.
   * An agent this Console moved to managed also loses the Console row it was
   * moved from; a failure there is left to the next automatic pass. */
  remove: async (params: {
    serverId: string;
    agentId: string;
    /** What the confirm said about the box's login (cloud agents, hosted agents v2), if anything. */
    confirmedWithdraw?: boolean;
  }): Promise<void> => {
    // On a cloud box with hosted agents v2, the box's login for the agent's
    // provider goes with its last agent there (as Switch web does it).
    await withReachableServerWorkspaceSession(params.serverId, (server) =>
      deleteMindingBoxLogin(params.agentId, {
        hostedV2: () => hostedV2On(server),
        agents: async () =>
          (await fetchManagedAgents(server)).map((agent) => ({
            agentId: agent.agentId,
            label: agent.displayName || agent.name,
            controllerId: agent.controllerId,
            provider: agent.provider,
          })),
        boxControllerId: async () =>
          ((await listCloudMachines(server)) ?? []).find((machine) => machine.backend === 'box')
            ?.controller_id ?? null,
        loginProviders: (controllerId) => fetchMachineLoginProviders(server, controllerId),
        withdrawLogin: async (controllerId, provider) => {
          try {
            await withdrawMachineLogin(server, controllerId, provider);
            return 'withdrawn';
          } catch (error) {
            if (error instanceof GatewayError && error.status === 404) return 'gone';
            throw error;
          }
        },
        deleteAgent: () => deleteAgent(server, params.agentId),
      }, params.confirmedWithdraw)
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

function liveControllerIds(
  controllers: readonly { id: string; revokedAt: string | null }[]
): Set<string> {
  return new Set(controllers.filter((c) => c.revokedAt === null).map((c) => c.id));
}

/** A SHA-256 of the account a provider's own sign-in file names, where it names one. Only Codex's
 * ChatGPT login does (`tokens.account_id`). gcloud's own sign-in file names no account, so Claude
 * through Vertex from this computer gets no account check (security accepted this); a pasted
 * Vertex key is always asked for again, so it needs none. */
function accountHashOf(provider: string, login: ProviderLogin): string | undefined {
  if (provider !== 'codex' || login.kind !== 'auth-json') return undefined;
  try {
    const parsed = JSON.parse(login.credential) as { tokens?: { account_id?: unknown } };
    const account = parsed.tokens?.account_id;
    return typeof account === 'string' && account.length > 0
      ? createHash('sha256').update(account).digest('hex')
      : undefined;
  } catch {
    return undefined;
  }
}

/** What Console keeps about a login it gave: its kind only, never the login. */
function sourceRecordFor(
  provider: string,
  input: MachineLoginInput,
  login: ProviderLogin
): LoginSourceRecord {
  if (input.source === 'vertex')
    return {
      source: input.credentials.from === 'this-computer' ? 'vertex-this-computer' : 'vertex-key',
      project: input.project,
      region: input.region,
    };
  if (input.source === 'typed') return { source: 'typed' };
  const accountHash = accountHashOf(provider, login);
  return accountHash === undefined
    ? { source: 'this-computer' }
    : { source: 'this-computer', accountHash };
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
    throw new Error(
      provider === 'codex'
        ? 'This computer is not signed in to codex. Sign in here first. If Codex says you are ' +
            'already signed in, its login is likely in the OS keyring, which cannot be given to ' +
            'another machine: unless your organization enforces the keyring, set ' +
            'cli_auth_credentials_store = "file" in the Codex config.toml and sign in again.'
        : `This computer is not signed in to ${provider}. Sign in here first.`
    );
  return { kind: 'auth-json', credential };
}
