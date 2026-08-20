import { remoteAttachmentPool } from '@main/core/agent-runtime/attachment/production-remote-attachment-pool';
import type { CreateSessionParams, SessionLifecycleStatus } from '@shared/core/sessions/sessions';
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
  /**
   * Tell the main process which session the user is looking at.
   *
   * Attachment is capped per remote host, and the focused session is the one
   * that must always have a terminal: it is pinned against eviction and
   * attached on demand. Pass null when leaving the session view.
   */
  async focusSession(sessionId: string | null) {
    remoteAttachmentPool.setFocused(sessionId);
  },
  /** Attach a session's terminal on request — the detached state's Attach button. */
  async attachSession(sessionId: string) {
    return remoteAttachmentPool.requestAttach(sessionId, 'user');
  },
  /** Close a session's terminal, leaving its agent running on the VM. */
  async detachSession(sessionId: string) {
    await remoteAttachmentPool.requestDetach(sessionId);
  },
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
  async provisionSession(sessionId: string) {
    return sessionService.provisionSession(sessionId);
  },
  generateSessionName,
});
