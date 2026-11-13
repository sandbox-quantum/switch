import { ChatActivityStream } from "@switch-console/chat-ui/client/activity-stream";
import { ChatStream, defaultBackoffMs } from "@switch-console/chat-ui/client/chat-stream";
import { dropMedia } from "@switch-console/chat-ui/components/chat-attachments";
import { ACTIVITY_UNAVAILABLE_TEXT } from "@switch-console/chat-ui/contracts/activity";
import type {
  ChatMessage,
  ChatRemovalReason,
  ChatStreamState,
  ChatSummary,
} from "@switch-console/chat-ui/contracts/chats";
import { AgentActivities } from "@switch-console/chat-ui/stores/chat-activity-store";
import { type ChatsEvents, ChatsStore } from "@switch-console/chat-ui/stores/chats-store";
import { ChatRequestError, callGateway, warn, webChatsClient } from "./webChatClient";

/**
 * The chat stores speak of servers, as Console holds several; the dashboard
 * is one server's, so every chat here is on this one.
 */
export const WEB_SERVER_ID = "web";

class Channel<T> {
  private readonly listeners = new Set<(data: T) => void>();

  on(listener: (data: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(data: T): void {
    for (const listener of this.listeners) listener(data);
  }
}

const setTimer = (fn: () => void, ms: number) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

const isUnauthorized = (error: unknown) =>
  error instanceof ChatRequestError && error.kind === "unauthorized";

/** Opens a live feed; any answer but a sign-in refusal is the feed's to judge. */
async function openFeed(path: string, signal: AbortSignal): Promise<Response> {
  const response = await fetch(`/gateway${path}`, { credentials: "include", signal });
  if (response.status === 401)
    throw new ChatRequestError("unauthorized", "You are signed out.", 401, null);
  return response;
}

function bytesOf(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

export type WebChats = {
  chats: ChatsStore;
  activities: AgentActivities;
  /** Opens the live feeds and reads the chats; `stop` closes them. */
  start: () => void;
  stop: () => void;
};

/**
 * The signed-in person's chats in the workspace the dashboard is in, kept
 * live from the server's chat and activity feeds, as Console keeps them.
 */
export function createWebChats(identity: { userId: string; tenantId: string }): WebChats {
  const message = new Channel<{ serverId: string; message: ChatMessage }>();
  const summary = new Channel<{ serverId: string; chat: ChatSummary }>();
  const removed = new Channel<{ serverId: string; roomId: string; reason: ChatRemovalReason }>();
  const state = new Channel<{ serverId: string; state: ChatStreamState; detail: string | null }>();
  const reset = new Channel<{ serverId: string }>();
  const events: ChatsEvents = {
    onMessage: (cb) => message.on(cb),
    onSummary: (cb) => summary.on(cb),
    onRemoved: (cb) => removed.on(cb),
    onState: (cb) => state.on(cb),
    onReset: (cb) => reset.on(cb),
  };
  const serverId = WEB_SERVER_ID;

  const stream = new ChatStream({
    listChats: () => webChatsClient.listChats(),
    open: (after, signal) =>
      openFeed(`/chats/events${after ? `?${new URLSearchParams({ after })}` : ""}`, signal),
    isUnauthorized,
    backoffMs: defaultBackoffMs,
    setTimer,
    warn,
    sink: {
      message: (each) => message.emit({ serverId, message: each }),
      summary: (chat) => summary.emit({ serverId, chat }),
      removed: (roomId, reason) => removed.emit({ serverId, roomId, reason }),
      state: (each, detail) => state.emit({ serverId, state: each, detail }),
    },
  });

  const chats = new ChatsStore(
    {
      connect: async () => {
        stream.start();
        activityStream.start();
        // A feed already down when the chats (re)connect sends no change to hear.
        activities.feedState(serverId, activityStream.state.state, activityStream.state.detail);
        return stream.state;
      },
      disconnect: async () => {
        stream.stop();
        activityStream.stop();
      },
      list: () => webChatsClient.listChats(),
      listArchived: () => webChatsClient.listArchivedChats(),
      identity: async () => identity,
      timeline: () => ({
        messages: (roomId, beforeSeq, limit) =>
          webChatsClient.fetchChatMessages(roomId, { beforeSeq, limit }),
        threadMessages: async (roomId, rootId, beforeSeq, limit) =>
          (
            await webChatsClient.fetchThreadMessages(roomId, rootId, {
              beforeSeq,
              limit: Math.min(200, Math.max(1, limit)),
            })
          ).messages,
        upload: (roomId, file) =>
          webChatsClient.uploadChatAttachment(roomId, {
            uploadId: file.uploadId,
            name: file.name,
            mimeType: file.mimeType,
            bytes: bytesOf(file.data),
          }),
        send: (roomId, input) => webChatsClient.sendChatMessage(roomId, input),
        newId: () => crypto.randomUUID(),
      }),
      archive: (_server, roomId) => webChatsClient.archiveChat(roomId),
      unarchive: (_server, roomId) => webChatsClient.unarchiveChat(roomId),
      delete: async (_server, roomId) => {
        await callGateway(`/rooms/${encodeURIComponent(roomId)}`, { method: "DELETE" });
      },
      markRead: (_server, roomId, seq) =>
        webChatsClient.markChatRead(roomId, seq).catch((error: unknown) => {
          // The store tries again on the next read; the server's count returns with the next summary.
          warn("Could not save how far a chat has been read", { roomId, seq, error: String(error) });
          throw error;
        }),
      removeMember: (_server, roomId, userId) => webChatsClient.removeChatMember(roomId, userId),
      // The dashboard reads rooms when a page opens; nothing here holds them.
      roomsChanged: async () => {},
    },
    events,
  );

  // Reasoning and full tool output are kept by an agent's session host, which
  // only Console on the agent's own computer can ask; the web shows the turns,
  // tools and requests Switch's activity feed carries.
  const activities = new AgentActivities(
    {
      resolve: async () => ({
        kind: "unavailable",
        reason: "not-on-this-machine",
        message: ACTIVITY_UNAVAILABLE_TEXT["not-on-this-machine"],
      }),
      reasoning: async () => null,
      watchPlacements: () => () => {},
      roomActivity: (_server, roomId) => webChatsClient.fetchRoomActivity(roomId),
      roomMessages: (server, roomId) => chats.timelines.peek(server, roomId)?.messages ?? [],
      control: (input) => webChatsClient.sendChatControl(input.roomId, input),
      retrySupport: async () => "unknown",
      answerApproval: (input) => webChatsClient.answerChatApproval(input, input.answer),
    },
    sessionStorage,
  );

  const activityStream = new ChatActivityStream({
    open: (signal) => openFeed("/chats/activity/events", signal),
    isUnauthorized,
    backoffMs: defaultBackoffMs,
    setTimer,
    warn,
    sink: {
      activity: (item) => activities.applyItem(serverId, item),
      approval: (approval) => activities.applyApproval(serverId, approval),
      resync: () => activities.resync(serverId),
      state: (each, detail) => activities.feedState(serverId, each, detail),
    },
  });

  removed.on(({ roomId, reason }) => {
    if (reason !== "access") return;
    activities.drop(serverId, roomId);
    dropMedia((_server, room) => room === roomId);
  });

  return {
    chats,
    activities,
    start: () => void chats.connect(serverId),
    stop: () => {
      void chats.connect(null);
      activities.drop(serverId, null);
      dropMedia(() => true);
    },
  };
}
