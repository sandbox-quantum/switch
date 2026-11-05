import type { ChatSummary } from '@shared/core/chats/chats';

/** Prefix of the id a direct chat goes by on screen until its room exists. */
export const UNSAVED_CHAT_PREFIX = 'unsaved-chat:';

/** What an unsaved chat is called: the name the server gives a chat made without one. */
export const UNSAVED_CHAT_NAME = 'New Chat';

/** Whose chats these are on a server: an unsaved chat belongs to one account and workspace. */
export type ChatScope = {
  serverId: string;
  userId: string | null;
  workspaceId: string | null;
};

/** The error an unsaved chat's send gets when the account or workspace changed under it. */
export const SCOPE_CHANGED =
  'You switched account or workspace before this chat was made, so its message was not sent.';

export type UnsavedChat = ChatScope & {
  agentId: string;
  /** The id it goes by on screen until its room exists. */
  roomId: string;
  /** One per unsaved chat: every attempt to make its room is the same request, so the server makes one room. */
  requestId: string;
};

export type DirectChatStarterDeps = {
  create: (input: {
    serverId: string;
    agentIds: string[];
    name: null;
    requestId: string;
    greeting: null;
  }) => Promise<ChatSummary>;
  /** The unsaved chat is being opened, new or again; `create` makes its room, on its first send. */
  opened: (chat: UnsavedChat, create: () => Promise<string>) => void;
  /** Its room exists: the chat moves from its unsaved id to the room's. */
  created: (unsaved: UnsavedChat, chat: ChatSummary) => void;
  /** The account and workspace the server's chats belong to now. */
  scope: (serverId: string) => ChatScope;
  /** The create request id of the agent's unsaved chat kept from an earlier session, if it still has a draft. */
  kept: (scope: ChatScope, agentId: string) => string | null;
  /** Keep the agent's unsaved chat's create request id across restarts; null forgets it. */
  keep: (scope: ChatScope, agentId: string, requestId: string | null) => void;
  newId: () => string;
};

/**
 * Starts an unnamed direct chat with one agent. Nothing is asked of the server
 * until the first message: the chat opens at once under an unsaved id, and its
 * room is made as that message is sent. Starting again for the same agent
 * before then opens the same unsaved chat, with whatever was typed in it, and
 * so does starting after a restart, under the same create request id.
 */
export class DirectChatStarter {
  private readonly unsaved = new Map<string, UnsavedChat>();
  private readonly byRoomId = new Map<string, UnsavedChat>();
  private readonly creating = new Map<string, Promise<string>>();

  constructor(private readonly deps: DirectChatStarterDeps) {}

  /** The id of the chat to open: the agent's unsaved one, made now if it has none. */
  start(serverId: string, agentId: string): string {
    const scope = this.deps.scope(serverId);
    const key = keyOf(scope, agentId);
    let chat = this.unsaved.get(key);
    if (!chat) {
      const requestId = this.deps.kept(scope, agentId) ?? this.deps.newId();
      this.deps.keep(scope, agentId, requestId);
      chat = { ...scope, agentId, roomId: `${UNSAVED_CHAT_PREFIX}${requestId}`, requestId };
      this.unsaved.set(key, chat);
      this.byRoomId.set(chat.roomId, chat);
    }
    const opened = chat;
    this.deps.opened(opened, () => this.create(opened));
    return chat.roomId;
  }

  /** The id of the agent's unsaved chat, open in this session or kept from an earlier one with a draft; null if none. */
  waiting(serverId: string, agentId: string): string | null {
    const scope = this.deps.scope(serverId);
    const open = this.unsaved.get(keyOf(scope, agentId));
    if (open) return open.roomId;
    const kept = this.deps.kept(scope, agentId);
    return kept ? `${UNSAVED_CHAT_PREFIX}${kept}` : null;
  }

  /** The unsaved chat shown under `roomId`, while its room does not exist yet. */
  unsavedChat(roomId: string): UnsavedChat | undefined {
    return this.byRoomId.get(roomId);
  }

  private inScope(chat: UnsavedChat): boolean {
    return keyOf(this.deps.scope(chat.serverId), chat.agentId) === keyOf(chat, chat.agentId);
  }

  /** Make the chat's room, once however often asked; a failure lets the next ask try again under the same request id. */
  private create(chat: UnsavedChat): Promise<string> {
    let creating = this.creating.get(chat.roomId);
    if (!creating) {
      if (!this.inScope(chat)) return Promise.reject(new Error(SCOPE_CHANGED));
      creating = this.deps
        .create({
          serverId: chat.serverId,
          agentIds: [chat.agentId],
          name: null,
          requestId: chat.requestId,
          greeting: null,
        })
        .then(
          (created) => {
            this.creating.delete(chat.roomId);
            // Made for the account it was started in; another's view must not take it.
            if (!this.inScope(chat)) throw new Error(SCOPE_CHANGED);
            this.unsaved.delete(keyOf(chat, chat.agentId));
            this.byRoomId.delete(chat.roomId);
            this.deps.keep(chat, chat.agentId, null);
            this.deps.created(chat, created);
            return created.roomId;
          },
          (error: unknown) => {
            this.creating.delete(chat.roomId);
            throw error;
          }
        );
      this.creating.set(chat.roomId, creating);
    }
    return creating;
  }
}

function keyOf(scope: ChatScope, agentId: string): string {
  return JSON.stringify([scope.serverId, scope.userId, scope.workspaceId, agentId]);
}
