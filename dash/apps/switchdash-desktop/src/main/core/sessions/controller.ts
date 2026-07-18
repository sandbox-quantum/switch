import { dehydrateConversation } from '@main/core/conversations/dehydrateConversation';
import { deleteConversation } from '@main/core/conversations/deleteConversation';
import { getConversations } from '@main/core/conversations/getConversations';
import { getConversationsForProject } from '@main/core/conversations/getConversationsForProject';
import { getConversationsForSession } from '@main/core/conversations/getConversationsForSession';
import { hydrateConversation } from '@main/core/conversations/hydrateConversation';
import { markConversationSeen } from '@main/core/conversations/markConversationSeen';
import { renameConversation } from '@main/core/conversations/renameConversation';
import type { CreateSessionParams, SessionLifecycleStatus } from '@shared/core/sessions/sessions';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { sessionService } from './session-service';

export const sessionController = createRPCController({
  // Ex-conversation engine ops (a conversation is a session in switchdash).
  getConversations,
  deleteConversation,
  hydrateConversation,
  dehydrateConversation,
  renameConversation,
  getConversationsForSession,
  getConversationsForProject,
  markConversationSeen,
  async createSession(params: CreateSessionParams) {
    return sessionService.createSession(params);
  },
  async getSessions(projectId?: string) {
    return sessionService.getSessions(projectId);
  },
  async deleteSession(projectId: string, sessionId: string) {
    return sessionService.deleteSession(projectId, sessionId);
  },
  async deleteSessions(projectId: string, sessionIds: string[]) {
    return sessionService.deleteSessions(projectId, sessionIds);
  },
  async archiveSession(projectId: string, sessionId: string) {
    return sessionService.archiveSession(projectId, sessionId);
  },
  async restoreSession(id: string) {
    return sessionService.restoreSession(id);
  },
  async renameSession(projectId: string, sessionId: string, newTitle: string) {
    return sessionService.renameSession(projectId, sessionId, newTitle);
  },
  async updateSessionStatus(sessionId: string, status: SessionLifecycleStatus) {
    return sessionService.updateSessionStatus(sessionId, status);
  },
  async setSessionPinned(sessionId: string, isPinned: boolean) {
    return sessionService.setSessionPinned(sessionId, isPinned);
  },
  async teardownSession(_projectId: string, sessionId: string) {
    return sessionService.teardown(sessionId, 'terminate');
  },
  async provisionWorkspace(sessionId: string) {
    return sessionService.provisionWorkspace(sessionId);
  },
  generateSessionName,
});
