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

/** What a cloud agent's next start runs, as Core stores it on the launch. */
export type CloudLaunchConfiguration = {
  description: string;
  instructions: string;
  definition_attributes: RepoAgentAttributes;
};

/** An edit to a launch's configuration, with what its definition is rendered from. */
export type CloudConfigurationInput = {
  provider: AgentProviderId;
  name: string;
  description: string;
  instructions: string;
  definition_attributes: RepoAgentAttributes;
};

export type CloudRepositorySelection = {
  installationId: number;
  repositoryId: number;
};
