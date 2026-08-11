import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';

export interface AgentSessionConfig {
  sessionId: string;
  providerId: AgentProviderId;
  command: string;
  args: string[];
  cwd: string;
  agentSessionId?: string;
  shellSetup?: string;
  tmuxSessionName?: string;
  autoApprove: boolean;
  resume: boolean;
}
