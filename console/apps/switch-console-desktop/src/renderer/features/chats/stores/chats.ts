import { reaction } from 'mobx';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events, rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { agentActivities } from './activities';
import { agentChatsFlag } from './agent-chats-flag';
import { ChatTitler } from './chat-titler';
import { ChatsStore, chatsEventsFrom } from './chats-store';

/** The app's chats store, following the workspace the window is scoped to. */
export const chatsStore = new ChatsStore(
  {
    connect: async (serverId) => {
      const state = await rpc.chats.connect(serverId);
      // A feed already down when this renderer (re)connects sends no change to hear.
      agentActivities.feedState(serverId, state.activity.state, state.activity.detail);
      return state;
    },
    disconnect: (serverId) => rpc.chats.disconnect(serverId),
    list: (serverId) => rpc.chats.list(serverId),
    listArchived: (serverId) => rpc.chats.listArchived(serverId),
    identity: (serverId) => rpc.chats.identity(serverId),
    timeline: (serverId) => ({
      messages: (roomId, beforeSeq, limit) =>
        rpc.chats.messages({ serverId, roomId, beforeSeq, limit }),
      threadMessages: (roomId, rootId, beforeSeq, limit) =>
        rpc.chats.threadMessages({ serverId, roomId, rootId, beforeSeq, limit }),
      upload: (roomId, file) => rpc.chats.upload({ serverId, roomId, ...file }),
      send: (roomId, input) => rpc.chats.send({ serverId, roomId, ...input }),
      newId: () => crypto.randomUUID(),
    }),
    archive: (serverId, roomId) => rpc.chats.archive(serverId, roomId),
    unarchive: (serverId, roomId) => rpc.chats.unarchive(serverId, roomId),
    delete: (serverId, roomId) => rpc.chats.delete(serverId, roomId),
    removeMember: (serverId, roomId, userId) =>
      rpc.chats.removeMember({ serverId, roomId, userId }),
    markRead: (serverId, roomId, seq) =>
      rpc.chats.markRead({ serverId, roomId, seq }).catch((error: unknown) => {
        // The store tries again on the next read; the server's count returns with the next summary.
        log.warn('Could not save how far a chat has been read', {
          serverId,
          roomId,
          seq,
          error: String(error),
        });
        throw error;
      }),
  },
  chatsEventsFrom(events)
);

chatsStore.follow(() => {
  const serverId = workspacesStore.activeServerId;
  const active = workspacesStore.active;
  if (!serverId || agentChatsFlag(serverId) !== true) return { serverId: null, key: null };
  // Signing out and in again, or as someone else, is a new key: the feed opens again for it.
  const userId = switchServersStore.statusFor(serverId)?.user?.id ?? null;
  return { serverId, key: active ? `${active.id}:${active.tenantId}:${userId}` : null };
});

// Server status is otherwise read again only on focus; until it is, the sidebar asks a server it thinks is down for no room names.
reaction(
  () => (chatsStore.streamState === 'live' ? chatsStore.serverId : null),
  (serverId) => {
    if (serverId && !switchServersStore.isConnected(serverId))
      void switchServersStore.refreshStatus(serverId);
  }
);

export const chatTitler = new ChatTitler({
  title: (message) => rpc.chats.title(message),
  rename: (serverId, roomId, name) => rpc.chats.rename(serverId, roomId, name),
  chat: (roomId) => chatsStore.chat(roomId),
  add: (serverId, chat) => chatsStore.add(serverId, chat),
  warn: (message, context) => log.warn(message, context),
});
