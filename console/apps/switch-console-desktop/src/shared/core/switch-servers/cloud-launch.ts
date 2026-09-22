import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { z } from 'zod';
import type { AddressingPolicy } from './switch-servers';

export const cloudLaunchSchema = z.object({
  request_id: z.string().uuid(),
  name: z.string(),
  state: z.enum(['queued', 'provisioning', 'ready', 'error']),
  agent_id: z.string().nullable(),
  error: z.string().nullable(),
});

export type CloudLaunch = z.infer<typeof cloudLaunchSchema>;

export type CloudLaunchInput = {
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
