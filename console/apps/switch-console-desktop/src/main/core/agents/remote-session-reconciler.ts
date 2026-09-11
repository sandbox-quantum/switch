import { sessionSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { eq } from 'drizzle-orm';
import { sessionService } from '@main/core/sessions/session-service';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { fetchSdkSessions, fetchSdkSnapshot } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { makePtyId } from '@shared/core/pty/ptyId';
import { sessionStatusUpdatedChannel } from '@shared/core/sessions/sessionEvents';
import { getAgentById } from './getAgentById';

/** Discover server-owned sessions on either execution transport without starting providers. */
class RemoteSessionReconciler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
  private readonly deleted = new Set<string>();
  private readonly failures = new Map<string, string>();
  errors(): { agentId: string; message: string }[] {
    return [...this.failures].map(([agentId, message]) => ({ agentId, message }));
  }
  async refresh(agentId: string): Promise<void> {
    this.start(agentId);
    await this.tick(agentId);
  }

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
    this.failures.delete(agentId);
  }
  dispose(): void {
    for (const agentId of this.timers.keys()) this.stop(agentId);
    this.failures.clear();
  }
  tombstone(sessionId: string): void {
    this.deleted.add(sessionId);
  }

  private async tick(agentId: string): Promise<void> {
    if (this.inFlight.has(agentId)) return;
    this.inFlight.add(agentId);
    try {
      const agent = await getAgentById(agentId);
      if (!agent?.switchAgentId) {
        this.stop(agentId);
        return;
      }
      if (!agent.serverId) throw new Error('This linked agent has no Switch server configured.');
      const server = await getServer(agent.serverId);
      if (!server) throw new Error('The session discovery server is missing.');
      const remote = await fetchSdkSessions(server);
      if (!Array.isArray(remote))
        throw new Error(
          'The server returned an incompatible session list. Update Console and server together.'
        );
      const failures: string[] = [];
      const local = new Map(
        (
          await db
            .select({ id: sessions.id, status: sessions.status })
            .from(sessions)
            .where(eq(sessions.agentId, agentId))
        ).map((row) => [row.id, row.status])
      );
      for (const value of remote) {
        try {
          const session = sessionSchema.parse(value);
          if (session.agentId !== agent.switchAgentId || this.deleted.has(session.sessionId))
            continue;
          if (
            local.has(session.sessionId) &&
            (session.status === 'stopped' || session.status === 'error' || session.retired)
          ) {
            const status = session.status === 'stopped' ? 'cancelled' : 'review';
            if (local.get(session.sessionId) !== status) {
              await sessionService.updateSessionStatus(session.sessionId, status);
              events.emit(sessionStatusUpdatedChannel, { sessionId: session.sessionId, status });
            }
          }
          if (session.status === 'stopped') continue;
          let roomId = session.roomIds?.[0] ?? null;
          if (session.roomIds === undefined && !local.has(session.sessionId)) {
            const snapshot = snapshotSchema.parse(
              await fetchSdkSnapshot(server, session.sessionId)
            );
            roomId =
              snapshot.session.roomIds?.[0] ??
              [...snapshot.items].reverse().find((item) => item.origin?.roomId)?.origin?.roomId ??
              null;
          }
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
          if (!roomId && session.roomIds !== undefined)
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
        } catch (error) {
          failures.push(String(error));
        }
      }
      if (failures.length)
        throw new Error(
          `${failures.length} SDK session(s) could not be discovered. ${failures[0]}`
        );
      this.failures.delete(agentId);
    } catch (error) {
      this.failures.set(agentId, `Session discovery failed: ${String(error)}`);
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
