import type { CreateSessionParams, SessionLifecycleStatus } from '@shared/core/sessions/sessions';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { dehydrateSession } from './operations/dehydrateSession';
import { getSession } from './operations/getSession';
import { hydrateSession } from './operations/hydrateSession';
import { markSessionSeen } from './operations/markSessionSeen';
import { sessionService } from './session-service';

export const sessionController = createRPCController({
  getSession,
  hydrateSession,
  dehydrateSession,
  markSessionSeen,
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
  async stopAgent(sessionId: string) {
    return sessionService.stopAgent(sessionId);
  },
  async provisionWorkspace(sessionId: string) {
    return sessionService.provisionWorkspace(sessionId);
  },
  generateSessionName,
});
