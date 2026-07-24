import type { CreateAgentParams, RenameAgentParams } from '@shared/core/agents/agents';
import type { OnboardAgentParams } from '@shared/core/agents/onboarding';
import type { AgentVerifyResult } from '@shared/core/switch-servers/switch-servers';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { assignAgentServer } from './assignAgentServer';
import { createAgent } from './createAgent';
import { deleteAgent, type DeleteAgentOptions } from './deleteAgent';
import { getAgentById } from './getAgentById';
import { getAgents } from './getAgents';
import { onboardAgent } from './onboard-agent';
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
  onboardAgent: (params: OnboardAgentParams) => onboardAgent(params),
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
