import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import type { OnboardAgentParams } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { addAgent, type AddAgentParams } from './add-agent';
import {
  getAgentAdvancedFields,
  getAgentAdvancedSurface,
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
import { getAgentDefinitionFields } from './definition-fields';
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
import { resetRemoteAgent } from './reset-remote-agent';
import { setAgentAutoApprove, type AgentAutoApproveParams } from './setAgentAutoApprove';
import {
  getAgentAutoSession,
  setAgentAutoSession,
  type AgentAutoSessionParams,
} from './setAgentAutoSession';

export const agentsController = createRPCController({
  addAgent: (params: AddAgentParams) => addAgent(params),
  definitionFields: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentDefinitionFields(params.providerId)),
  /**
   * The per-agent advanced configuration, wherever the provider keeps it —
   * a repo-agent definition (Claude) or a launch profile (Codex). One form,
   * one editor; see `agent-advanced-config.ts`.
   */
  advancedFields: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentAdvancedFields(params.providerId)),
  advancedSurface: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentAdvancedSurface(params.providerId)),
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
  discoverLoadableAgentsInDir: (params: { sshHost: string; dir: string; serverId: string }) =>
    discoverLoadableAgentsInDir(params),
  attachConfiguredAgents: (params: AttachConfiguredAgentsParams) => attachConfiguredAgents(params),
  removeLoadableAgentConfig: (params: RemoveLoadableAgentConfigParams) =>
    removeLoadableAgentConfig(params),
  getAgents: (locationId?: string) => getAgents(locationId),
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
  setAgentAutoSession: (params: AgentAutoSessionParams): Promise<void> =>
    setAgentAutoSession(params),
  setAgentAutoApprove: (params: AgentAutoApproveParams): Promise<void> =>
    setAgentAutoApprove(params),
  getAgentAutoSession: (params: { agentId: string }): Promise<boolean> =>
    getAgentAutoSession(params),
});
