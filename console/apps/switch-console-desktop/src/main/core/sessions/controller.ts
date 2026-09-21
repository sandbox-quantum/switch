import { provisionTriggerOf } from '@main/core/telemetry/narrow';
import type { CreateSessionParams, SessionLifecycleStatus } from '@shared/core/sessions/sessions';
import type { SessionProvisionTrigger } from '@shared/core/telemetry/reporting';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { generateSessionName } from './name-generation/generateSessionName';
import { dehydrateSession } from './operations/dehydrateSession';
import { getSession } from './operations/getSession';
import { hydrateSession } from './operations/hydrateSession';
import { markSessionSeen } from './operations/markSessionSeen';
import { restartSessionAgent } from './operations/restartSessionAgent';
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
  /**
   * Restart a session's agent process in place, so a setting only read at spawn
   * (the Codex launch profile) reaches a session that is already running.
   */
  async restartAgent(sessionId: string) {
    return restartSessionAgent(sessionId);
  },
  async provisionSession(params: { sessionId: string; trigger: SessionProvisionTrigger }) {
    // The trigger is typed on this side of the channel but arrives from the
    // renderer, so it is checked rather than trusted — an unrecognised one
    // falls back to `initial`, which reports nothing.
    return sessionService.provisionSession(params.sessionId, provisionTriggerOf(params.trigger));
  },
  generateSessionName,
});
