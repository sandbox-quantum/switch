import type { CreateAgentParams, RenameAgentParams } from '@shared/core/agents/agents';
import type { OnboardAgentParams } from '@shared/core/agents/onboarding';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { addAgent, type AddAgentParams } from './add-agent';
import { assignAgentServer } from './assignAgentServer';
import { createAgent } from './createAgent';
import { getAgentDefinitionFields } from './definition-fields';
import { deleteAgent, type DeleteAgentOptions } from './deleteAgent';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { onboardAgent } from './onboard-agent';
import { onboardLocationAgents, type OnboardLocationParams } from './onboard-location-agents';
import { renameAgent } from './renameAgent';
import { resetRemoteAgent } from './reset-remote-agent';
import {
  getAgentAutoSession,
  setAgentAutoSession,
  type AgentAutoSessionParams,
} from './setAgentAutoSession';
import { updateAgent, type UpdateAgentParams } from './updateAgent';

export const agentsController = createRPCController({
  createAgent: (params: CreateAgentParams) => createAgent(params),
  addAgent: (params: AddAgentParams) => addAgent(params),
  definitionFields: (params: { providerId: AgentProviderId }) =>
    Promise.resolve(getAgentDefinitionFields(params.providerId)),
  onboardAgent: (params: OnboardAgentParams) => onboardAgent(params),
  onboardLocationAgents: (params: OnboardLocationParams) => onboardLocationAgents(params),
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
  getAgentAutoSession: (params: { agentId: string }): Promise<boolean> =>
    getAgentAutoSession(params),
});
