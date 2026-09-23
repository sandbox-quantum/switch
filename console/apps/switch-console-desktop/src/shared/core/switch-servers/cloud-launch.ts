import type { RepoAgentAttributes } from '@switch-console/core/agents/plugins';
import { z } from 'zod';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AddressingPolicy } from './switch-servers';

export const cloudLaunchSchema = z.object({
  request_id: z.string().uuid(),
  name: z.string(),
  provider: z.enum(['claude', 'codex', 'opencode', 'cursor', 'antigravity']).default('claude'),
  state: z.enum([
    'queued',
    'provisioning',
    'ready',
    'error',
    'stopping',
    'stopped',
    'deleting',
    'deleted',
  ]),
  desired_state: z.enum(['running', 'stopped', 'restart', 'deleted']),
  revision: z.number().int().positive(),
  agent_id: z.string().nullable(),
  error: z.string().nullable(),
  sleeping: z.boolean().default(false),
});

export type CloudLaunch = z.infer<typeof cloudLaunchSchema>;

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
