import { GatewayError, gatewayRequest } from '@main/core/switch-servers/gateway-client';
import { withWorkspaceSession } from '@main/core/workspaces/workspace-session';
import { requireWorkspaceForServer } from '@main/core/workspaces/workspaces-store';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  chatMessageChannel,
  chatRemovedChannel,
  chatResetChannel,
  chatStreamStateChannel,
  chatSummaryChannel,
} from '@shared/core/chats/chatEvents';
import type { ChatStreamState } from '@shared/core/chats/chats';
import { ChatStream, defaultBackoffMs } from './chat-stream';
import { listChats } from './gateway';

/**
 * The chats feed for each server, for the tenant the window is scoped to.
 *
 * One feed per server: the window shows one workspace of a server at a time,
 * and a feed opened for one tenant answers for that tenant only. Connecting
 * under another tenant, or signing out, drops the old feed and tells the
 * renderer to forget everything it held for the server.
 *
 * The request that opens a feed takes the workspace lease only until the
 * server answers; reading the body holds nothing, so a workspace switch is
 * never kept waiting on a feed that does not end.
 */

type Entry = { tenantId: string | null; workspaceId: string; stream: ChatStream };
const streams = new Map<string, Entry>();

function makeStream(serverId: string, workspaceId: string): ChatStream {
  return new ChatStream({
    listChats: () => withWorkspaceSession(workspaceId, listChats),
    open: (after, signal) =>
      withWorkspaceSession(workspaceId, (server) =>
        gatewayRequest(
          server,
          `/chats/events${after ? `?${new URLSearchParams({ after })}` : ''}`,
          { authenticated: true, signal }
        )
      ),
    isUnauthorized: (error) => error instanceof GatewayError && error.kind === 'unauthorized',
    backoffMs: defaultBackoffMs,
    setTimer: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return () => clearTimeout(timer);
    },
    sink: {
      message: (message) => events.emit(chatMessageChannel, { serverId, message }),
      summary: (chat) => events.emit(chatSummaryChannel, { serverId, chat }),
      removed: (roomId, reason) => events.emit(chatRemovedChannel, { serverId, roomId, reason }),
      state: (state, detail) => {
        if (state === 'offline')
          log.warn('Chats live feed offline', { event: 'chat_stream_offline', serverId, detail });
        events.emit(chatStreamStateChannel, { serverId, state, detail });
      },
    },
  });
}

/** Drop the server's feed and tell the renderer its chats are stale. */
export function resetChatStream(serverId: string): void {
  const entry = streams.get(serverId);
  if (entry) {
    entry.stream.stop();
    streams.delete(serverId);
  }
  events.emit(chatResetChannel, { serverId });
}

/**
 * Make sure the server's feed runs for the tenant the window is scoped to now,
 * and say where it stands. A feed for another tenant is dropped first.
 */
export async function connectChatStream(
  serverId: string
): Promise<{ state: ChatStreamState; detail: string | null }> {
  const workspace = await requireWorkspaceForServer(serverId);
  const existing = streams.get(serverId);
  if (
    existing &&
    existing.workspaceId === workspace.id &&
    existing.tenantId === workspace.tenantId
  ) {
    existing.stream.start();
    return existing.stream.state;
  }
  if (existing) resetChatStream(serverId);
  const stream = makeStream(serverId, workspace.id);
  streams.set(serverId, { tenantId: workspace.tenantId, workspaceId: workspace.id, stream });
  stream.start();
  return stream.state;
}

/** Stop the feed without forgetting anything, e.g. when no window needs it. */
export function disconnectChatStream(serverId: string): void {
  streams.get(serverId)?.stream.stop();
  streams.delete(serverId);
}

/** Reconnect now from the cursors reached. */
export function resyncChatStream(serverId: string): void {
  streams.get(serverId)?.stream.resync();
}
