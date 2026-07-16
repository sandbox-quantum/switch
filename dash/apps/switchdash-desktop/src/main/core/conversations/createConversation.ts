import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { withCompensation } from '@main/core/utils/compensation';
import { db } from '@main/db/client';
import { agents, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { conversationCreatedChannel } from '@shared/core/conversations/conversationEvents';
import {
  type Conversation,
  type CreateConversationParams,
} from '@shared/core/conversations/conversations';
import { type AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { type AgentEvent } from '@shared/core/providers/agentEvents';
import { agentHookService } from '../agent-hooks/agent-hook-service';
import { isAppFocused } from '../agent-hooks/notification';
import { resolveSession } from '../projects/utils';
import { conversationEvents } from './conversation-events';
import { mapSessionRowToConversation } from './utils';

type ConversationCreateDb = Pick<typeof db, 'delete' | 'insert' | 'select'>;

function emitInitialPromptStarted(
  conversation: Conversation,
  params: CreateConversationParams
): void {
  if (!params.initialPrompt?.trim()) return;

  const agentEvent: AgentEvent = {
    type: 'start',
    source: 'input',
    providerId: params.provider,
    projectId: params.projectId,
    sessionId: params.sessionId,
    conversationId: conversation.id,
    timestamp: Date.now(),
    payload: {},
  };
  agentHookService.emitAgentEvent(agentEvent, isAppFocused());
}

/**
 * Resolves the agent that should own a new session, given the project and the
 * provider the renderer requested. A session belongs to exactly one agent; the
 * agent carries the provider, so we match on (projectId, providerId).
 */
async function resolveAgentId(
  database: ConversationCreateDb,
  projectId: string,
  provider: AgentProviderId
): Promise<string> {
  const [row] = await database
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.providerId, provider)))
    .limit(1);
  if (!row) {
    throw new Error(`No agent for project ${projectId} with provider ${provider}`);
  }
  return row.id;
}

export async function createConversation(
  params: CreateConversationParams,
  database: ConversationCreateDb = db
): Promise<Conversation> {
  const id = params.id ?? randomUUID();
  const agentId = await resolveAgentId(database, params.projectId, params.provider);

  const config = params.autoApprove === undefined ? undefined : { autoApprove: params.autoApprove };

  const [row] = await database
    .insert(sessions)
    .values({
      id,
      agentId,
      title: params.title,
      config,
      agentSessionId: id,
      isInitialSession: params.isInitialConversation ?? false,
      createdAt: sql`CURRENT_TIMESTAMP`,
      updatedAt: sql`CURRENT_TIMESTAMP`,
      lastInteractedAt: new Date().toISOString(),
    })
    .returning();

  const session = resolveSession(params.projectId, params.sessionId);
  if (!session) {
    throw new Error('Session not found');
  }

  const conversation = mapSessionRowToConversation(row, params.projectId, params.provider);

  await withCompensation({
    action: () =>
      session.conversations.startSession(
        conversation,
        params.initialSize,
        false,
        params.initialPrompt
      ),
    compensate: async () => {
      await database.delete(sessions).where(eq(sessions.id, row.id)).execute();
    },
    onCompensationError: (error) => {
      log.error('createConversation: failed to roll back session row after spawn failure', {
        conversationId: id,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  conversationEvents._emit('conversation:created', conversation);
  events.emit(conversationCreatedChannel, { conversation });
  emitInitialPromptStarted(conversation, params);

  return conversation;
}
