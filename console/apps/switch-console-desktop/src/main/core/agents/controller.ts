import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import type { CreateAgentParams, RenameAgentParams } from '@shared/core/agents/agents';
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
import { readAgentDefinition, updateAgentDefinition } from './agent-definition';
import { assignAgentServer } from './assignAgentServer';
import {
  attachConfiguredAgents,
  type AttachConfiguredAgentsParams,
} from './attach-configured-agents';
import { createAgent } from './createAgent';
import { getAgentDefinitionFields } from './definition-fields';
import { deleteAgent, type DeleteAgentOptions } from './deleteAgent';
import { discoverConfiguredAgents } from './discover-configured-agents';
import { discoverLocationAgents } from './discover-location-agents';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { onboardAgent } from './onboard-agent';
import { onboardLocationAgents, type OnboardLocationParams } from './onboard-location-agents';
import { renameAgent } from './renameAgent';
import { resetRemoteAgent } from './reset-remote-agent';
import { setAgentAutoApprove, type AgentAutoApproveParams } from './setAgentAutoApprove';
import {
  getAgentAutoSession,
  setAgentAutoSession,
  type AgentAutoSessionParams,
} from './setAgentAutoSession';
import { setAgentProviderConfig, type AgentProviderConfigParams } from './setAgentProviderConfig';
import { updateAgent, type UpdateAgentParams } from './updateAgent';

export const agentsController = createRPCController({
  createAgent: (params: CreateAgentParams) => createAgent(params),
  addAgent: (params: AddAgentParams) => addAgent(params),
  definitionFields: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentDefinitionFields(params.providerId)),
  readAgentDefinition: (params: { agentId: string }) => readAgentDefinition(params.agentId),
  updateAgentDefinition: (params: { agentId: string; attributes: RepoAgentAttributes }) =>
    updateAgentDefinition(params),
  /**
   * The per-agent advanced configuration, wherever the provider keeps it —
   * a repo-agent definition (Claude) or a launch profile (Codex). One form,
   * one editor; see `agent-advanced-config.ts`.
   */
  advancedFields: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentAdvancedFields(params.providerId)),
  advancedSurface: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentAdvancedSurface(params.providerId)),
  readAdvancedConfig: (params: { agentId: string }) => readAgentAdvancedConfig(params.agentId),
  updateAdvancedConfig: (params: { agentId: string; attributes: RepoAgentAttributes }) =>
    updateAgentAdvancedConfig(params),
  onboardAgent: (params: OnboardAgentParams) => onboardAgent(params),
  onboardLocationAgents: (params: OnboardLocationParams) => onboardLocationAgents(params),
  discoverLocationAgents: (params: {
    sshHost: string | null;
    dir: string;
    providerId: AgentProviderId;
    serverId: string;
  }) => discoverLocationAgents(params),
  discoverConfiguredAgents: (params: { sshHost: string | null; dir: string; serverId: string }) =>
    discoverConfiguredAgents(params),
  attachConfiguredAgents: (params: AttachConfiguredAgentsParams) => attachConfiguredAgents(params),
  getAgents: (locationId?: string) => getAgents(locationId),
  getAgentById: (agentId: string) => getAgentById(agentId),
  renameAgent: (params: RenameAgentParams) => renameAgent(params),
  deleteAgent: (params: { agentId: string } & DeleteAgentOptions) =>
    deleteAgent(params.agentId, { deleteInSwitch: params.deleteInSwitch }),
  resetRemoteAgent: (params: { agentId: string }) => resetRemoteAgent(params.agentId),
  updateAgent: (params: UpdateAgentParams) => updateAgent(params),
  assignServer: (params: { agentId: string; serverId: string }): Promise<AgentVerifyResult> =>
    assignAgentServer(params),
  setAgentAutoSession: (params: AgentAutoSessionParams): Promise<void> =>
    setAgentAutoSession(params),
  setAgentAutoApprove: (params: AgentAutoApproveParams): Promise<void> =>
    setAgentAutoApprove(params),
  setAgentProviderConfig: (params: AgentProviderConfigParams): Promise<void> =>
    setAgentProviderConfig(params),
  getAgentAutoSession: (params: { agentId: string }): Promise<boolean> =>
    getAgentAutoSession(params),
});
