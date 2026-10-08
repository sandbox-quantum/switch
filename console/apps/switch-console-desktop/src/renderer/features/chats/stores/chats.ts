import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { events, rpc } from '@renderer/lib/ipc';
import { ChatsStore, chatsEventsFrom } from './chats-store';

/** The app's chats store, following the workspace the window is scoped to. */
export const chatsStore = new ChatsStore(
  {
    connect: (serverId) => rpc.chats.connect(serverId),
    list: (serverId) => rpc.chats.list(serverId),
    identity: (serverId) => rpc.chats.identity(serverId),
    timeline: (serverId) => ({
      messages: (roomId, beforeSeq, limit) =>
        rpc.chats.messages({ serverId, roomId, beforeSeq, limit }),
      upload: (roomId, file) => rpc.chats.upload({ serverId, roomId, ...file }),
      send: (roomId, input) => rpc.chats.send({ serverId, roomId, ...input }),
      newId: () => crypto.randomUUID(),
    }),
  },
  chatsEventsFrom(events)
);

chatsStore.follow(() => ({
  serverId: workspacesStore.activeServerId,
  key: workspacesStore.active
    ? `${workspacesStore.active.id}:${workspacesStore.active.tenantId}`
    : null,
}));
