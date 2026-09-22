import { sessionSchema, snapshotSchema } from '@switch-console/shared/session-v1';
import { eq } from 'drizzle-orm';
import { syncSdkSessionActivity } from '@main/core/sdk-host/session-activity';
import { sessionWasDeleted } from '@main/core/sessions/deleted-sessions';
import { sessionService } from '@main/core/sessions/session-service';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import {
  fetchRoomDetail,
  fetchSdkSessions,
  fetchSdkSnapshot,
} from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { AGENT_PROVIDER_IDS } from '@shared/core/providers/agent-provider-registry';
import { makeHookSessionId } from '@shared/core/providers/hook-session-id';
import { sessionStatusUpdatedChannel } from '@shared/core/sessions/sessionEvents';
import { getAgentById } from './getAgentById';

/** Discover server-owned sessions on either execution transport without starting providers. */
class RemoteSessionReconciler {
  private readonly timers = new Map<string, ReturnType<typeof setInterval>>();
  private readonly inFlight = new Set<string>();
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
          if (
            value &&
            typeof value === 'object' &&
            'agentId' in value &&
            value.agentId !== agent.switchAgentId
          )
            continue;
          if (value && typeof value === 'object' && 'discoveryError' in value)
            throw new Error(String(value.discoveryError));
          const session = sessionSchema.parse(value);
          if (!AGENT_PROVIDER_IDS.some((provider) => provider === session.provider))
            throw new Error(
              `Session ${session.sessionId} uses unsupported provider "${session.provider}". Update Console to open it.`
            );
          if (session.agentId !== agent.switchAgentId || sessionWasDeleted(session.sessionId))
            continue;
          if (local.has(session.sessionId)) await syncSdkSessionActivity(session);
          if (
            local.has(session.sessionId) &&
            (session.status === 'stopped' ||
              session.status === 'error' ||
              session.retired ||
              (local.get(session.sessionId) === 'cancelled' &&
                (session.status === 'ready' || session.status === 'running')))
          ) {
            const status =
              session.status === 'stopped'
                ? 'cancelled'
                : session.status === 'ready' || session.status === 'running'
                  ? 'in_progress'
                  : 'review';
            if (local.get(session.sessionId) !== status) {
              await sessionService.updateSessionStatus(session.sessionId, status);
              events.emit(sessionStatusUpdatedChannel, { sessionId: session.sessionId, status });
            }
          }
          // A retired session is finished; adopting one puts a row back for
          // work that will never resume.
          if (session.status === 'stopped' || session.retired) continue;
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
                ptyId: makeHookSessionId(agent.providerId, session.sessionId),
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
            title: roomId
              ? `Session for ${(await fetchRoomDetail(server, roomId)).name}`
              : 'Shared session',
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
                ptyId: makeHookSessionId(agent.providerId, session.sessionId),
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
      const message = `Session discovery failed: ${String(error)}`;
      const changed = this.failures.get(agentId) !== message;
      this.failures.set(agentId, message);
      if (changed)
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
