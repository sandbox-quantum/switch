import { runInAction } from 'mobx';
import type { ChatSummary } from '../contracts/chats';
import { chatDraftKey, moveChatDraft, readChatDraft, unsavedChatKey } from '../stores/chat-drafts';
import type { ChatsStore } from '../stores/chats-store';
import {
  type ChatScope,
  DirectChatStarter,
  type DirectChatStarterDeps,
  UNSAVED_CHAT_PREFIX,
  type UnsavedChat,
} from '../stores/direct-chat-starter';
import { focusComposerWhenOpened } from './chat-composer';

/**
 * A {@link DirectChatStarter} wired to an app's chats store: an unsaved chat
 * opens with a timeline that makes its room on the first send, keeps its draft
 * and create request id across reloads in `storage`, and moves onto its room
 * once made. `moved` is the app's part of that move (what shows the unsaved
 * id now shows the room's), run in the same action as the store's.
 */
export function directChatsFor(deps: {
  chats: ChatsStore;
  create: DirectChatStarterDeps['create'];
  scope: (serverId: string) => ChatScope;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
  newId: () => string;
  moved: (unsaved: UnsavedChat, chat: ChatSummary) => void;
}): DirectChatStarter {
  const { chats, storage } = deps;
  return new DirectChatStarter({
    create: deps.create,
    opened: (chat, create) => {
      if (!chats.timelines.peek(chat.serverId, chat.roomId))
        chats.timelines.unsaved(chat.serverId, chat.roomId, create);
      focusComposerWhenOpened(chat.roomId);
    },
    created: (unsaved, chat) => {
      const { serverId, roomId: from } = unsaved;
      const draftKey = (roomId: string) => chatDraftKey({ ...unsaved, roomId });
      moveChatDraft(draftKey(from), draftKey(chat.roomId));
      if (document.activeElement?.closest('[data-chat-panel]'))
        focusComposerWhenOpened(chat.roomId);
      runInAction(() => {
        chats.timelines.rekey(serverId, from, chat.roomId);
        chats.add(serverId, chat);
        deps.moved(unsaved, chat);
      });
    },
    scope: deps.scope,
    kept: (chatScope, agentId) => {
      const key = unsavedChatKey({ ...chatScope, agentId });
      const requestId = key && storage.getItem(key);
      if (!key || !requestId) return null;
      const roomId = `${UNSAVED_CHAT_PREFIX}${requestId}`;
      if (readChatDraft(chatDraftKey({ ...chatScope, roomId }))) return requestId;
      // Emptied before it was sent: nothing to come back to.
      storage.removeItem(key);
      return null;
    },
    keep: (chatScope, agentId, requestId) => {
      const key = unsavedChatKey({ ...chatScope, agentId });
      if (!key) return;
      if (requestId) storage.setItem(key, requestId);
      else storage.removeItem(key);
    },
    newId: deps.newId,
  });
}
