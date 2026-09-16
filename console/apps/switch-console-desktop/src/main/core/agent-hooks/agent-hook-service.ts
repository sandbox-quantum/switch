import type { IDisposable, IInitializable } from '@switch-console/shared';
import { eq } from 'drizzle-orm';
import { getPlugin } from '@main/core/providers/plugin-registry';
import { setProviderSessionId } from '@main/core/sessions/operations/set-provider-session-id';
import { touchSession } from '@main/core/sessions/operations/touchSession';
import { sessionHooks } from '@main/core/sessions/session-hooks';
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
  if (status === 'awaiting-input' || status === 'error') return 'needs_attention';
  if (status === 'completed' && event.type === 'stop') return 'session_complete';
  return undefined;
}

async function handleSessionEvent(
  ctx: { sessionId: string; providerId: string },
  providerSessionId: string
): Promise<void> {
  if (!isValidProviderSessionId(ctx.providerId, providerSessionId)) return;

  const updated = await setProviderSessionId(ctx.sessionId, providerSessionId);
  if (!updated) return;

  events.emit(sessionChangedChannel, {
    sessionId: ctx.sessionId,
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

  async handleRawHook(raw: RawHookRequest): Promise<void> {
    let parsed;
    try {
      parsed = await parseHookEvent(raw, dbContextResolver, log);
    } catch (error) {
      log.warn('AgentHookService: failed to parse hook event', {
        ptyId: raw.ptyId,
        type: raw.type,
        error: String(error),
      });
      return;
    }

    // Any hook at all proves the CLI is past its startup prompts and running,
    // so this is deliberately not narrowed to the session-start event: a
    // provider that varies its startup payload should not read as stalled.

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
      return;
    }

    if (parsed.kind === 'activity') return;

    const event = parsed.event;
    const appFocused = isAppFocused();
    await maybeShowNotification(event, appFocused);
    this.emitAgentEvent(event, appFocused);
  }

  async initialize(): Promise<void> {
    await this.server.start(async (raw) => this.handleRawHook(raw));

    sessionHooks.on('session:input-submitted', ({ sessionId, providerId }) => {
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
          sessionId,
          timestamp: Date.now(),
          payload: {},
        };
        this.emitAgentEvent(agentEvent, isAppFocused());
      }

      const now = new Date().toISOString();
      void touchSession(sessionId, now).then(() => {
        events.emit(sessionChangedChannel, {
          sessionId,
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
        sessionId: event.sessionId,
        status,
        eventType: event.type,
        ...(notificationType ? { notificationType } : {}),
        seen: seen === 1,
      });

      await db
        .update(sessions)
        .set({ agentStatus: status, agentStatusSeen: seen })
        .where(eq(sessions.id, event.sessionId));

      events.emit(sessionAgentStatusChangedChannel, {
        sessionId: event.sessionId,
        status,
        seen: seen === 1,
        soundEvent: determineSoundEvent(event, status),
        notificationType,
      });
    });
  }

  dispose(): void {
    this.server.stop();
  }

  getPort(): number {
    return this.server.getPort();
  }

  getToken(): string {
    return this.server.getToken();
  }
}

export const agentHookService = new AgentHookService();
