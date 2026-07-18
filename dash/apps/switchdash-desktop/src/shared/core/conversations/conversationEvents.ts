import type { Conversation } from '@shared/core/conversations/conversations';
import { defineEvent } from '@shared/lib/ipc/events';
import type { AgentStatus, NotificationType } from '../providers/agentEvents';

export const conversationChangedChannel = defineEvent<{
  conversationId: string;
  sessionId: string;
  projectId: string;
  changes: Partial<Pick<Conversation, 'lastInteractedAt' | 'title' | 'providerSessionId'>>;
}>('conversation:changed');

export const conversationAgentStatusChangedChannel = defineEvent<{
  conversationId: string;
  sessionId: string;
  projectId: string;
  status: AgentStatus;
  seen: boolean;
  soundEvent?: 'needs_attention' | 'session_complete';
  /**
   * For status changes driven by a notification hook, the specific kind. Lets
   * consumers distinguish an idle agent waiting at its prompt (`idle_prompt`)
   * from one genuinely blocked on a dialog (`permission_prompt`), which both map
   * to the `awaiting-input` status.
   */
  notificationType?: NotificationType;
}>('conversation:agent-status-changed');
