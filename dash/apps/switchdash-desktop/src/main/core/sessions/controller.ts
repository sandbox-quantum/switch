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
  async getSessions(locationId?: string) {
    return sessionService.getSessions(locationId);
  },
  async deleteSession(sessionId: string) {
    return sessionService.deleteSession(sessionId);
  },
  async deleteSessions(sessionIds: string[]) {
    return sessionService.deleteSessions(sessionIds);
  },
  async archiveSession(sessionId: string) {
    return sessionService.archiveSession(sessionId);
  },
  async restoreSession(id: string) {
    return sessionService.restoreSession(id);
  },
  async renameSession(sessionId: string, newTitle: string) {
    return sessionService.renameSession(sessionId, newTitle);
  },
  async updateSessionStatus(sessionId: string, status: SessionLifecycleStatus) {
    return sessionService.updateSessionStatus(sessionId, status);
  },
  async setSessionPinned(sessionId: string, isPinned: boolean) {
    return sessionService.setSessionPinned(sessionId, isPinned);
  },
  async teardownSession(sessionId: string) {
    return sessionService.teardown(sessionId, 'terminate');
  },
  async stopAgent(sessionId: string) {
    return sessionService.stopAgent(sessionId);
  },
  async provisionSession(sessionId: string) {
    return sessionService.provisionSession(sessionId);
  },
  generateSessionName,
});
