import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import type { AgentStatus } from '@shared/core/providers/agentEvents';

export const MAX_CONVERSATION_TITLE_LENGTH = 100;

export type Conversation = {
  id: string;
  projectId: string;
  sessionId: string;
  providerId: AgentProviderId;
  title: string;
  lastInteractedAt: string | null;
  resume?: boolean;
  autoApprove?: boolean;
  /** Provider-native session id captured at runtime for per-chat resume. */
  providerSessionId?: string;
  /** Set when this session runs as a Claude Code subagent (`--agent <name>`). */
  subagentName?: string;
  isInitialConversation: boolean | null;
  agentStatus?: AgentStatus | null;
  agentStatusSeen?: boolean;
};

export type RenameConversationParams = {
  conversationId: string;
  newTitle: string;
};
