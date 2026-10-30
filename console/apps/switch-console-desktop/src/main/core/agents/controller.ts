import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { listManagedAgentRecords } from '@main/core/agent-migration/managed-agents-store';
import type { OnboardAgentParams } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { addAgent, type AddAgentParams } from './add-agent';
import {
  getAgentAdvancedSettings,
  readAgentAdvancedConfig,
  updateAgentAdvancedConfig,
} from './agent-advanced-config';
import {
  readAgentInstructions,
  readAgentTemplateOrigin,
  setAgentInstructions,
} from './agent-config';
import { getAgentModelCatalogue, getProviderReadiness } from './agent-model-catalogue';
import { assignAgentServer } from './assignAgentServer';
import {
  attachConfiguredAgents,
  type AttachConfiguredAgentsParams,
} from './attach-configured-agents';
import { deleteAgent, type DeleteAgentOptions } from './deleteAgent';
import {
  discoverLoadableAgentsInDir,
  discoverLoadableAgentsOnHost,
  type DiscoverLoadableAgentsParams,
} from './discover-loadable-agents';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { onboardAgent } from './onboard-agent';
import type { RemoveLoadableAgentConfigParams } from './remove-loadable-agent-config';
import { removeLoadableAgentConfig } from './remove-loadable-agent-config';
import { renameLocalAgent } from './renameAgent';
import { resetRemoteAgent } from './reset-remote-agent';
import { setAgentPermission, type AgentPermissionParams } from './setAgentPermission';

export const agentsController = createRPCController({
  addAgent: (params: AddAgentParams) => addAgent(params),
  /**
   * Where the provider keeps the per-agent advanced configuration — a
   * repo-agent definition (Claude) or a launch profile (Codex) — and which of
   * the server's fields it applies. One form, one editor; see
   * `agent-advanced-config.ts`.
   */
  advancedSettings: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentAdvancedSettings(params.providerId)),
  /**
   * The models the agent's own host offers, for the advanced-configuration
   * fields that declare a catalogue binding. Reports why it could not be read
   * rather than throwing: the form degrades to plain text and says so.
   */
  providerReadiness: (params: {
    providerId: AgentProviderId;
    sshHost: string | null;
    dir: string;
  }) => getProviderReadiness(params, false),
  modelCatalogue: (params: { providerId: AgentProviderId; sshHost: string | null; dir: string }) =>
    getAgentModelCatalogue(params),
  /**
   * The agent's instructions — its system prompt, held in the committed config
   * file in its working directory and rendered into whatever its provider
   * reads. Separate from `readAdvancedConfig` because it is a main attribute of
   * the agent rather than one of its provider's settings.
   */
  readInstructions: (params: { agentId: string }) => readAgentInstructions(params.agentId),
  readTemplateOrigin: (params: { agentId: string }) => readAgentTemplateOrigin(params.agentId),
  updateInstructions: (params: { agentId: string; instructions: string }): Promise<void> =>
    setAgentInstructions(params).then(() => undefined),
  readAdvancedConfig: (params: { agentId: string }) => readAgentAdvancedConfig(params.agentId),
  updateAdvancedConfig: (params: { agentId: string; attributes: RepoAgentAttributes }) =>
    updateAgentAdvancedConfig(params),
  onboardAgent: (params: OnboardAgentParams) => onboardAgent(params),
  discoverLoadableAgentsOnHost: (params: DiscoverLoadableAgentsParams) =>
    discoverLoadableAgentsOnHost(params),
  discoverLoadableAgentsInDir: (params: { sshHost: string; dir: string; workspaceId: string }) =>
    discoverLoadableAgentsInDir(params),
  attachConfiguredAgents: (params: AttachConfiguredAgentsParams) => attachConfiguredAgents(params),
  removeLoadableAgentConfig: (params: RemoveLoadableAgentConfigParams) =>
    removeLoadableAgentConfig(params),
  getAgents: (locationId?: string) => getAgents(locationId),
  /** The Console agents moved to agent management: shown through the managed list only, never as Console agents. */
  movedAgentIds: async (): Promise<string[]> =>
    (await listManagedAgentRecords()).map((record) => record.agentId),
  /**
   * Give a Console agent its new name locally, after its Switch server has
   * renamed it (`workspaces.renameAgent`): the row and the files keyed by the
   * name. Throws `RenameLocalAgentFailed` before writing anything when the
   * name is taken here.
   */
  renameLocal: (params: { agentId: string; newName: string }) => renameLocalAgent(params),
  getAgentById: (agentId: string) => getAgentById(agentId),
  deleteAgent: (params: { agentId: string } & DeleteAgentOptions) =>
    deleteAgent(params.agentId, {
      deleteInSwitch: params.deleteInSwitch,
      removeProvisionedFiles: params.removeProvisionedFiles,
      trigger: params.trigger,
    }),
  resetRemoteAgent: (params: { agentId: string }) => resetRemoteAgent(params.agentId),
  assignServer: (params: { agentId: string; serverId: string }): Promise<AgentVerifyResult> =>
    assignAgentServer(params),
  setAgentPermission: (params: AgentPermissionParams): Promise<void> => setAgentPermission(params),
});
