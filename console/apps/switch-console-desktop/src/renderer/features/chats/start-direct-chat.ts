import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { focusComposerWhenOpened } from './components/chat-composer';
import { chatsStore, chatTitler } from './stores/chats';
import { DirectChatStarter } from './stores/direct-chat-starter';
import { EmptyChatFinder } from './stores/empty-chat-finder';

const emptyChatFinder = new EmptyChatFinder({
  chatsOfAgent: (agentId) => chatsStore.chatsOfAgent(agentId),
  userId: () => chatsStore.userId,
  timeline: (roomId) => {
    const timeline = chatsStore.timelines.peek(chatsStore.serverId ?? '', roomId);
    return timeline ? { messages: timeline.messages, loaded: timeline.loaded } : undefined;
  },
});

/** Starts a direct chat with one agent, named later from its first message. */
export const directChats = new DirectChatStarter({
  create: (input) => rpc.chats.create(input),
  created: (serverId, chat) => {
    chatsStore.add(serverId, chat);
    chatTitler.created(chat, false);
    focusComposerWhenOpened(chat.roomId);
  },
  opened: (chat) => {
    focusComposerWhenOpened(chat.roomId);
  },
  warm: (serverId, agentId, roomId) =>
    void rpc.chats
      .warm({ serverId, agentId, roomId })
      .catch((error: unknown) =>
        log.warn('Could not ask for the agent’s session in a reused chat', { roomId, error })
      ),
  failed: (message) =>
    toast({ title: 'Could not start the chat', description: message, variant: 'destructive' }),
  findEmpty: (agentId) => emptyChatFinder.find(agentId),
  newId: () => crypto.randomUUID(),
});
