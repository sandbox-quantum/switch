import { sessionSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { eq } from 'drizzle-orm';
import { sessionService } from '@main/core/sessions/session-service';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { fetchSdkSessions, fetchSdkSnapshot } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { makePtyId } from '@shared/core/pty/ptyId';
import { getAgentById } from './getAgentById';

/** Discover server-owned sessions on either execution transport without starting providers. */
class RemoteSessionReconciler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private readonly deleted = new Set<string>();

  start(agentId: string): void {
    if (this.timers.has(agentId)) return;
    const timer = setInterval(() => void this.tick(agentId), 2000);
    timer.unref();
    this.timers.set(agentId, timer);
    void this.tick(agentId);
  }
  stop(agentId: string): void {
    clearInterval(this.timers.get(agentId));
    this.timers.delete(agentId);
  }
  dispose(): void {
    for (const agentId of this.timers.keys()) this.stop(agentId);
  }
  tombstone(sessionId: string): void {
    this.deleted.add(sessionId);
  }

  private async tick(agentId: string): Promise<void> {
    if (this.inFlight.has(agentId)) return;
    this.inFlight.add(agentId);
    try {
      const agent = await getAgentById(agentId);
      if (!agent?.switchAgentId || !agent.serverId) {
        this.stop(agentId);
        return;
      }
      const server = await getServer(agent.serverId);
      if (!server) throw new Error('The session discovery server is missing.');
      const remote = sessionSchema.array().parse(await fetchSdkSessions(server));
      const local = new Set(
        (
          await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.agentId, agentId))
        ).map((row) => row.id)
      );
      for (const session of remote) {
        if (
          session.agentId !== agent.switchAgentId ||
          session.status === 'stopped' ||
          this.deleted.has(session.sessionId)
        )
          continue;
        const snapshot = snapshotSchema.parse(await fetchSdkSnapshot(server, session.sessionId));
        const roomId =
          snapshot.session.roomIds !== undefined
            ? (snapshot.session.roomIds[0] ?? null)
            : ([...snapshot.items].reverse().find((item) => item.origin?.roomId)?.origin?.roomId ??
              null);
        if (roomId)
          switchRoomService.mirrorRemoteSessionRoom(
            {
              sessionId: session.sessionId,
              providerId: agent.providerId,
              ptyId: makePtyId(agent.providerId, session.sessionId),
            },
            roomId,
            agent.switchAgentId
          );
        if (!roomId && snapshot.session.roomIds !== undefined)
          switchRoomService.clearSession(session.sessionId);
        if (local.has(session.sessionId)) continue;
        const result = await sessionService.createSession({
          id: session.sessionId,
          agentId,
          title: roomId ? 'Room session' : 'Shared session',
          autoApprove: agent.autoApprove,
          attach: false,
          startSource: 'adopted',
        });
        if (!result.success) {
          if (result.error.type === 'already-exists') continue;
          throw new Error(`Could not adopt SDK session: ${JSON.stringify(result.error)}`);
        }
        const provisioned = await sessionService.provisionSession(session.sessionId);
        if (!provisioned.success)
          throw new Error(
            `Could not provision SDK session view: ${JSON.stringify(provisioned.error)}`
          );
        if (roomId)
          switchRoomService.mirrorRemoteSessionRoom(
            {
              sessionId: session.sessionId,
              providerId: agent.providerId,
              ptyId: makePtyId(agent.providerId, session.sessionId),
            },
            roomId,
            agent.switchAgentId
          );
      }
    } catch (error) {
      log.error('Shared SDK session discovery failed; existing sessions are retained', {
        agentId,
        error: String(error),
      });
    } finally {
      this.inFlight.delete(agentId);
    }
  }
}
export const remoteSessionReconciler = new RemoteSessionReconciler();
