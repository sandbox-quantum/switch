import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AddressingPolicy } from './switch-servers';

export type CloudLaunchInput = {
  provider: AgentProviderId;
  request_id: string;
  name: string;
  description: string;
  display_name: string | null;
  icon_url: string | null;
  instructions: string;
  installation_id: number;
  repository_id: number;
  definition_attributes: RepoAgentAttributes;
  auto_session: boolean;
  auto_approve: boolean;
  addressing_policy: AddressingPolicy | null;
};

export type CloudRepositorySelection = {
  installationId: number;
  repositoryId: number;
};
