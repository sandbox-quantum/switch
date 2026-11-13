import { directChatsFor } from '@switch-console/chat-ui/components/direct-chats';
import type { ChatScope } from '@switch-console/chat-ui/stores/direct-chat-starter';
import { switchServersStore } from '@renderer/features/switch-servers/switch-servers-store';
import { workspacesStore } from '@renderer/features/workspaces/workspaces-store';
import { rpc } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { chatsStore, chatTitler } from './stores/chats';

function scope(serverId: string): ChatScope {
  return {
    serverId,
    userId: switchServersStore.statusFor(serverId)?.user?.id ?? null,
    workspaceId: workspacesStore.idOnServerInScope(serverId),
  };
}

/** Starts a direct chat with one agent, made on its first message and named from it. */
export const directChats = directChatsFor({
  chats: chatsStore,
  create: (input) => rpc.chats.create(input),
  scope,
  storage: localStorage,
  newId: () => crypto.randomUUID(),
  moved: (unsaved, chat) => {
    const { serverId, roomId: from } = unsaved;
    for (const entry of appState.history.entries)
      if (entry.kind === 'view' && (entry.params as { roomId?: string }).roomId === from)
        entry.params = { ...entry.params, roomId: chat.roomId };
    for (const viewId of ['chat', 'managedAgent'] as const)
      if (appState.navigation.viewParamsStore[viewId]?.roomId === from)
        appState.navigation.updateViewParams(viewId, { roomId: chat.roomId });
    // Saved now, not on the next debounce: a reload before then would reopen the unsaved id, which is gone.
    void rpc.viewState.save('navigation', appState.navigation.snapshot);
    chatTitler.created(chat, false);
    const first = chatsStore.timelines.peek(serverId, chat.roomId)?.pending[0];
    if (first) void chatTitler.sent(serverId, chat.roomId, first.body);
  },
});
