import { sessionSchema } from '@switch-console/shared/session-v1';
import { eq } from 'drizzle-orm';
import { listHostSessions } from '@main/core/sdk-host/host-sessions';
import { syncSdkSessionActivity } from '@main/core/sdk-host/session-activity';
import { sessionWasDeleted } from '@main/core/sessions/deleted-sessions';
import { sessionService } from '@main/core/sessions/session-service';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { fetchRoomDetail } from '@main/core/switch-servers/gateway-client';
import { getServer } from '@main/core/switch-servers/servers-store';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { AGENT_PROVIDER_IDS } from '@shared/core/providers/agent-provider-registry';
import { makeHookSessionId } from '@shared/core/providers/hook-session-id';
import { sessionStatusUpdatedChannel } from '@shared/core/sessions/sessionEvents';
import { getAgentById } from './getAgentById';

/** How often a linked agent's sessions are listed while discovery is healthy. */
export const DISCOVERY_MS = 5000;
/** The longest a failing discovery waits before trying again. */
export const DISCOVERY_MAX_BACKOFF_MS = 60000;
/** Discover an agent's sessions from its host, locally or over SSH, without starting providers. */
class RemoteSessionReconciler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly failedRounds = new Map<string, number>();
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
    this.schedule(agentId, 0);
  }
  /** The next round: steady while healthy, doubling while it keeps failing. */
  private schedule(agentId: string, delay: number): void {
    const timer = setTimeout(() => {
      void this.tick(agentId).then(() => {
        if (this.timers.get(agentId) !== timer) return;
        const failed = this.failedRounds.get(agentId) ?? 0;
        this.schedule(
          agentId,
          failed ? Math.min(DISCOVERY_MS * 2 ** failed, DISCOVERY_MAX_BACKOFF_MS) : DISCOVERY_MS
        );
      });
    }, delay);
    timer.unref();
    this.timers.set(agentId, timer);
  }
  stop(agentId: string): void {
    clearTimeout(this.timers.get(agentId));
    this.timers.delete(agentId);
    this.failures.delete(agentId);
    this.failedRounds.delete(agentId);
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
      const remote: unknown[] = await listHostSessions(agentId);
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
          const roomId = session.roomIds?.[0] ?? null;
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
      this.failedRounds.delete(agentId);
    } catch (error) {
      this.failedRounds.set(agentId, (this.failedRounds.get(agentId) ?? 0) + 1);
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
