import { eq } from 'drizzle-orm';
import { remoteSessionReconciler } from '@main/core/agents/remote-session-reconciler';
import { projectManager } from '@main/core/projects/project-manager';
import { killTmuxSession, makeAgentTmuxSessionName } from '@main/core/pty/tmux-session-name';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { resolveSession } from '../projects/utils';
import { conversationEvents } from './conversation-events';

export async function deleteConversation(
  projectId: string,
  sessionId: string,
  conversationId: string
): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, conversationId));

  // Refuse reconciler re-adoption of this id before the sidecar /disconnect
  // (sent below via stopSession) lands, so it can't recreate the ghost row.
  remoteSessionReconciler.tombstone(conversationId);

  conversationEvents._emit('conversation:deleted', conversationId);

  const session = resolveSession(projectId, sessionId);
  if (session) {
    await session.agent.stop();
  } else {
    const project = projectManager.getProject(projectId);
    if (project) {
      await killTmuxSession(project.ctx, makeAgentTmuxSessionName(conversationId));
    }
  }
}
