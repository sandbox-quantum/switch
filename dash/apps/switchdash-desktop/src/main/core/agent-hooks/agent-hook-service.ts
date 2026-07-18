import type { IDisposable, IInitializable } from '@switchdash/shared';
import { eq } from 'drizzle-orm';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { saveProviderSessionId } from '@main/core/sessions/operations/save-provider-session-id';
import { setProviderSessionId } from '@main/core/sessions/operations/set-provider-session-id';
import { touchSession } from '@main/core/sessions/operations/touchSession';
import { sessionHooks } from '@main/core/sessions/session-hooks';
import { loadSessionWithAgent } from '@main/core/sessions/session-join';
import { switchNotificationPoller } from '@main/core/switch-rooms/switch-notification-poller';
import { switchRoomService } from '@main/core/switch-rooms/switch-room-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { HookCore, type Hookable } from '@main/lib/hookable';
import { log } from '@main/lib/logger';
import { isValidProviderSessionId } from '@shared/core/providers/agent-provider-registry';
import { type AgentEvent, type AgentStatus } from '@shared/core/providers/agentEvents';
import {
  sessionAgentStatusChangedChannel,
  sessionChangedChannel,
} from '@shared/core/sessions/sessionEvents';
import { dbContextResolver } from './db-context-resolver';
import { deriveAgentStatus } from './derive-agent-status';
import { parseHookEvent } from './event-enricher';
import { HookServer, type RawHookRequest } from './hook-server';
import { isAppFocused, maybeShowNotification } from './notification';

export type AgentHookServiceHooks = {
  'agent:event': (event: AgentEvent, appFocused: boolean) => void | Promise<void>;
};

function determineSoundEvent(
  event: AgentEvent,
  status: AgentStatus
): 'needs_attention' | 'session_complete' | undefined {
  if (status === 'awaiting-input') return 'needs_attention';
  if (status === 'completed' && event.type === 'stop') return 'session_complete';
  return undefined;
}

async function handleSessionEvent(
  ctx: { conversationId: string; sessionId: string; projectId: string; providerId: string },
  providerSessionId: string
): Promise<void> {
  if (!isValidProviderSessionId(ctx.providerId, providerSessionId)) return;

  if (ctx.providerId === 'droid') {
    await saveProviderSessionId(ctx.sessionId, providerSessionId);
    return;
  }

  const updated = await setProviderSessionId(ctx.sessionId, providerSessionId);
  if (!updated) return;

  events.emit(sessionChangedChannel, {
    sessionId: ctx.sessionId,
    projectId: ctx.projectId,
    changes: { providerSessionId },
  });
}

class AgentHookService implements IInitializable, IDisposable, Hookable<AgentHookServiceHooks> {
  private server = new HookServer(log);
  private readonly _hooks = new HookCore<AgentHookServiceHooks>((name, e) =>
    log.error(`AgentHookService: ${String(name)} hook error`, e)
  );

  on<K extends keyof AgentHookServiceHooks>(name: K, handler: AgentHookServiceHooks[K]) {
    return this._hooks.on(name, handler);
  }

  emitAgentEvent(event: AgentEvent, appFocused: boolean): void {
    this._hooks.callHookBackground('agent:event', event, appFocused);
  }

  /**
   * Process one raw hook callback. Local sessions (`startLocalPoller: true`)
   * start switchdash's own room poller on a `connect_to_room`. Remote sessions
   * relayed from the on-VM sidecar (`startLocalPoller: false`) skip it — the
   * sidecar owns polling and tmux injection on the VM; switchdash only records
   * the room and status for display so it must not start a competing poller.
   */
  async handleRawHook(raw: RawHookRequest, opts: { startLocalPoller: boolean }): Promise<void> {
    let parsed;
    try {
      parsed = await parseHookEvent(raw, dbContextResolver);
    } catch (error) {
      log.warn('AgentHookService: failed to parse hook event', {
        ptyId: raw.ptyId,
        type: raw.type,
        error: String(error),
      });
      return;
    }

    if (parsed.kind === 'ignore') return;

    if (parsed.kind === 'session') {
      await handleSessionEvent(parsed.ctx, parsed.providerSessionId).catch((error) => {
        log.warn('AgentHookService: failed to persist session id', {
          ptyId: raw.ptyId,
          error: String(error),
        });
      });
      return;
    }

    if (parsed.kind === 'switch-room') {
      switchRoomService.setSessionRoom(parsed.ctx, parsed.roomId, parsed.agentId, parsed.roomName);
      if (opts.startLocalPoller) {
        switchNotificationPoller.connect(parsed.ctx, parsed.roomId, parsed.roomName);
      }
      return;
    }

    if (parsed.kind === 'activity') {
      // Surface the running turn's activity on the bridged channel by refreshing
      // the "working on it…" message. A no-op unless a room-triggered turn is
      // live. In-process call: the `events` bus is renderer-bound (see below).
      switchNotificationPoller.onAgentActivity(parsed.ctx.conversationId, parsed.detail);
      return;
    }

    const event = parsed.event;
    const appFocused = isAppFocused();
    await maybeShowNotification(event, appFocused);
    this.emitAgentEvent(event, appFocused);
  }

  async initialize(): Promise<void> {
    await this.server.start(async (raw) => this.handleRawHook(raw, { startLocalPoller: true }));

    sessionHooks.on('session:input-submitted', ({ projectId, sessionId, providerId }) => {
      // Only synthesise a 'start' event when the plugin does not supply its own
      // start hook (e.g. UserPromptSubmit). Providers with start-capable hooks
      // get 'working' from the real hook event instead.
      const plugin = getPlugin(providerId);
      const hooksDesc = plugin?.capabilities.hooks;
      const supportedEvents =
        hooksDesc && hooksDesc.kind !== 'none' ? hooksDesc.supportedEvents : [];
      const hasStartHook = supportedEvents.includes('start');

      if (!hasStartHook) {
        const agentEvent: AgentEvent = {
          type: 'start',
          source: 'input',
          providerId,
          projectId,
          sessionId,
          conversationId: sessionId,
          timestamp: Date.now(),
          payload: {},
        };
        this.emitAgentEvent(agentEvent, isAppFocused());
      }

      const now = new Date().toISOString();
      void touchSession(sessionId, now).then(() => {
        events.emit(sessionChangedChannel, {
          sessionId,
          projectId,
          changes: { lastInteractedAt: now },
        });
      });
    });

    // Persist agent status to DB and emit simplified IPC for renderer.
    this.on('agent:event', async (event) => {
      log.debug('AgentHookService: raw event', event);
      const status = deriveAgentStatus(event);
      if (!status) return;
      const seen = status === 'idle' || status === 'working' ? 1 : 0;
      const notificationType =
        event.type === 'notification' ? event.payload.notificationType : undefined;

      log.debug('AgentHookService: agent status change', {
        conversationId: event.conversationId,
        status,
        eventType: event.type,
        ...(notificationType ? { notificationType } : {}),
        seen: seen === 1,
      });

      // Drive the notification poller's injection gate directly. In the main
      // process the `events` bus is renderer-bound (emit → webContents.send, on →
      // ipcMain), so an in-process emit never reaches an in-process listener — the
      // poller would otherwise never observe a turn finishing and would release
      // its gate only via the 60s fallback.
      switchNotificationPoller.onAgentStatusChange(event.conversationId, status, notificationType);

      await db
        .update(sessions)
        .set({ agentStatus: status, agentStatusSeen: seen })
        .where(eq(sessions.id, event.conversationId));

      events.emit(sessionAgentStatusChangedChannel, {
        sessionId: event.sessionId,
        projectId: event.projectId,
        status,
        seen: seen === 1,
        soundEvent: determineSoundEvent(event, status),
        notificationType,
      });
    });

    // Reset a stuck 'working' status to 'idle' when the agent PTY exits
    // unexpectedly (the user interrupts/kills the agent before a 'stop' or
    // 'error' hook fires). Subscribed in-process: the `events` bus only delivers
    // main→renderer, so this handler must use sessionHooks. Poller/room
    // teardown is NOT done here — this also fires on respawn, where the poller
    // should survive; that teardown lives at the stop/delete lifecycle points.
    sessionHooks.on('session:agent-exited', ({ sessionId }) => {
      void (async () => {
        try {
          const loaded = await loadSessionWithAgent(sessionId);
          if (!loaded || loaded.row.agentStatus !== 'working') return;

          await db
            .update(sessions)
            .set({ agentStatus: 'idle', agentStatusSeen: 1 })
            .where(eq(sessions.id, sessionId));

          switchNotificationPoller.onAgentStatusChange(sessionId, 'idle');

          events.emit(sessionAgentStatusChangedChannel, {
            sessionId,
            projectId: loaded.projectId,
            status: 'idle',
            seen: true,
            soundEvent: undefined,
          });
        } catch (error) {
          log.warn('AgentHookService: failed to reset stuck working status on exit', {
            sessionId,
            error: String(error),
          });
        }
      })();
    });
  }

  dispose(): void {
    this.server.stop();
    switchNotificationPoller.dispose();
  }

  getPort(): number {
    return this.server.getPort();
  }

  getToken(): string {
    return this.server.getToken();
  }
}

export const agentHookService = new AgentHookService();
