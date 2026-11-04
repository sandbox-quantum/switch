import { makeAutoObservable, reaction, runInAction } from 'mobx';
import { switchRoomsStore } from '@renderer/features/switch-servers/switch-rooms-store';
import { failureText } from '@renderer/lib/errors/describe-failure';
import {
  chatMessageChannel,
  chatRemovedChannel,
  chatResetChannel,
  chatStreamStateChannel,
  chatSummaryChannel,
} from '@shared/core/chats/chatEvents';
import type {
  ChatMessage,
  ChatRemovalReason,
  ChatStreamState,
  ChatSummary,
} from '@shared/core/chats/chats';
import { ChatTimelines, type TimelineApi } from './chat-timeline-store';

/**
 * The signed-in person's chats on the server the window is scoped to, kept
 * live by the main process's feed, and the timelines of the chats opened.
 *
 * A reset (sign-out, tenant switch) drops everything held for the server; a
 * removal for lost access drops the room's messages and marks it lost, so an
 * open chat can say so instead of quietly emptying. A room merely unlisted
 * (still a member, e.g. no agents left) only leaves the list: an open chat
 * keeps reading and posting, and catches up if the room is listed again.
 */

export type ChatsApi = {
  connect: (serverId: string) => Promise<{ state: ChatStreamState; detail: string | null }>;
  disconnect: (serverId: string) => Promise<void>;
  list: (serverId: string) => Promise<ChatSummary[]>;
  listArchived: (serverId: string) => Promise<ChatSummary[]>;
  identity: (serverId: string) => Promise<{ userId: string; tenantId: string | null }>;
  timeline: (serverId: string) => TimelineApi;
  archive: (serverId: string, roomId: string) => Promise<void>;
  unarchive: (serverId: string, roomId: string) => Promise<void>;
  delete: (serverId: string, roomId: string) => Promise<void>;
  markRead: (serverId: string, roomId: string, seq: number) => Promise<void>;
  removeMember: (serverId: string, roomId: string, userId: string) => Promise<void>;
};

/** How long reading settles before the read position is sent. */
export const READ_DEBOUNCE_MS = 400;

export type ChatsEvents = {
  onMessage: (cb: (data: { serverId: string; message: ChatMessage }) => void) => () => void;
  onSummary: (cb: (data: { serverId: string; chat: ChatSummary }) => void) => () => void;
  onRemoved: (
    cb: (data: { serverId: string; roomId: string; reason: ChatRemovalReason }) => void
  ) => () => void;
  onState: (
    cb: (data: { serverId: string; state: ChatStreamState; detail: string | null }) => void
  ) => () => void;
  onReset: (cb: (data: { serverId: string }) => void) => () => void;
};

export class ChatsStore {
  serverId: string | null = null;
  userId: string | null = null;
  tenantId: string | null = null;
  chats = new Map<string, ChatSummary>();
  /** Rooms the person lost access to since the feed started. */
  removed = new Set<string>();
  /** Rooms off the list while the person is still a member. */
  unlisted = new Set<string>();
  /** The person's archived chats: off the list, still readable, and written back into it. */
  archived = new Map<string, ChatSummary>();
  archivedError: string | null = null;
  streamState: ChatStreamState = 'offline';
  streamDetail: string | null = null;
  listError: string | null = null;
  /** The room whose chat is on screen and being read: its messages do not count as unread. */
  viewing: string | null = null;
  /** The furthest message the server has taken as read, by room; a read never moves back. */
  private readonly readThrough = new Map<string, number>();
  /** A read position on its way to the server, by room; dropped if it fails, so the next read retries. */
  private readonly readPending = new Map<string, number>();
  private readonly readTimers = new Map<string, ReturnType<typeof setTimeout>>();
  readonly timelines: ChatTimelines;

  constructor(
    private readonly api: ChatsApi,
    events: ChatsEvents
  ) {
    this.timelines = new ChatTimelines(api.timeline);
    makeAutoObservable<ChatsStore, 'api' | 'readThrough' | 'readPending' | 'readTimers'>(this, {
      api: false,
      timelines: false,
      readThrough: false,
      readPending: false,
      readTimers: false,
    });
    events.onSummary(({ serverId, chat }) => {
      if (serverId === this.serverId) this.upsert(chat);
    });
    events.onMessage(({ serverId, message }) => this.message(serverId, message));
    events.onRemoved(({ serverId, roomId, reason }) => {
      if (serverId !== this.serverId) return;
      this.remove(roomId, reason);
      // Archiving is one way a chat leaves the list while its people stay in it.
      if (reason === 'unlisted') void this.loadArchived(serverId);
    });
    events.onState(({ serverId, state, detail }) => {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.streamState = state;
        this.streamDetail = detail;
      });
      // A first load that failed while the server was down is not retried by anything else.
      if (state !== 'live') return;
      if (this.userId === null || this.listError) void this.connect(serverId);
      this.timelines.reload(serverId);
    });
    events.onReset(({ serverId }) => this.reset(serverId));
  }

  /**
   * Follow the server the window is scoped to; `key` changes with the workspace
   * and the account signed in there. A new key on the same server starts over:
   * the feed is opened again under the new sign-in, and nothing of the last
   * account's chats is kept.
   */
  follow(read: () => { serverId: string | null; key: string | null }): () => void {
    let following: string | null = null;
    return reaction(
      read,
      ({ serverId }) => {
        const again = serverId !== null && serverId === following;
        following = serverId;
        void (async () => {
          if (again) await this.connect(null);
          await this.connect(serverId);
        })();
      },
      {
        fireImmediately: true,
        equals: (a, b) => a.serverId === b.serverId && a.key === b.key,
      }
    );
  }

  async connect(serverId: string | null): Promise<void> {
    if (serverId !== this.serverId) {
      if (this.serverId) void this.api.disconnect(this.serverId);
      runInAction(() => {
        this.serverId = serverId;
        this.chats = new Map();
        this.removed = new Set();
        this.unlisted = new Set();
        this.archived = new Map();
        this.archivedError = null;
        this.userId = null;
        this.tenantId = null;
        this.listError = null;
        this.streamState = serverId ? 'connecting' : 'offline';
        this.streamDetail = null;
      });
    }
    if (!serverId) return;
    try {
      const [state, identity, chats] = await Promise.all([
        this.api.connect(serverId),
        this.api.identity(serverId),
        this.api.list(serverId),
      ]);
      if (serverId !== this.serverId) {
        void this.api.disconnect(serverId);
        return;
      }
      runInAction(() => {
        this.streamState = state.state;
        this.streamDetail = state.detail;
        this.userId = identity.userId;
        this.tenantId = identity.tenantId;
        this.listError = null;
        for (const chat of chats) this.upsert(chat);
      });
    } catch (error) {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.listError = failureText(error, 'Your chats could not be listed.');
      });
    }
    await this.loadArchived(serverId);
  }

  async loadArchived(serverId: string): Promise<void> {
    try {
      const chats = await this.api.listArchived(serverId);
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.archived = new Map(
          chats.filter((chat) => !this.chats.has(chat.roomId)).map((chat) => [chat.roomId, chat])
        );
        this.archivedError = null;
      });
    } catch (error) {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.archivedError = failureText(error, 'Your archived chats could not be listed.');
      });
    }
  }

  upsert(chat: ChatSummary): void {
    this.chats.set(chat.roomId, chat);
    this.removed.delete(chat.roomId);
    const wasArchived = this.archived.delete(chat.roomId);
    const timeline = this.serverId ? this.timelines.peek(this.serverId, chat.roomId) : undefined;
    timeline?.restore();
    // The feed did not follow the room while it was off the list.
    if ((this.unlisted.delete(chat.roomId) || wasArchived) && timeline?.loaded)
      void timeline.load();
  }

  /** A chat the person made or was let into from here, ahead of the feed. */
  add(serverId: string, chat: ChatSummary): void {
    if (serverId === this.serverId) this.upsert(chat);
  }

  /** Archived for everyone in it; throws, leaving the chat listed, if the server refuses. */
  async archive(serverId: string, roomId: string): Promise<void> {
    await this.api.archive(serverId, roomId);
    const chat = this.chats.get(roomId);
    this.remove(roomId, 'unlisted');
    if (chat) this.archived.set(roomId, chat);
    await switchRoomsStore.refreshRoomState();
  }

  /** Back on the list for everyone in it; throws, leaving it archived, if the server refuses. */
  async unarchive(serverId: string, roomId: string): Promise<void> {
    await this.api.unarchive(serverId, roomId);
    const chat = this.archived.get(roomId);
    if (chat) this.upsert(chat);
    await switchRoomsStore.refreshRoomState();
  }

  /** Deleted with its messages for everyone; throws, leaving the chat listed, if the server refuses. */
  async delete(serverId: string, roomId: string): Promise<void> {
    await this.api.delete(serverId, roomId);
    this.remove(roomId, 'access');
    await switchRoomsStore.refreshRoomState();
  }

  /** Leaves the chat; throws, leaving it listed and open, if the server refuses. */
  async leave(serverId: string, roomId: string): Promise<void> {
    if (this.userId === null) throw new Error('Not signed in to this chat’s server yet.');
    await this.api.removeMember(serverId, roomId, this.userId);
    this.remove(roomId, 'access');
    await switchRoomsStore.refreshRoomState();
  }

  message(serverId: string, message: ChatMessage): void {
    if (serverId !== this.serverId) return;
    this.timelines.peek(serverId, message.roomId)?.apply(message);
    const chat = this.chats.get(message.roomId);
    // The feed follows hidden chats too; a message in one is what brings it back.
    if (
      !chat &&
      !this.removed.has(message.roomId) &&
      !this.unlisted.has(message.roomId) &&
      !this.archived.has(message.roomId)
    )
      void this.relist(serverId);
    if (chat && (chat.lastMessage === null || chat.lastMessage.seq < message.seq))
      this.chats.set(message.roomId, {
        ...chat,
        // Counted here until the server's next summary says otherwise.
        unreadCount:
          message.sender.userId !== this.userId && this.viewing !== message.roomId
            ? chat.unreadCount + 1
            : chat.unreadCount,
        lastMessage: {
          seq: message.seq,
          sentAt: message.sentAt,
          preview: message.body.slice(0, 200),
          senderName: message.sender.name,
        },
      });
  }

  /**
   * Read every chat's summary again. What a summary says of its agents, such
   * as a name, can change with no message or summary on the feed (an agent
   * renamed), and the participants and mention suggestions are read from it.
   */
  async refreshSummaries(): Promise<void> {
    const serverId = this.serverId;
    if (!serverId) return;
    try {
      const chats = await this.api.list(serverId);
      if (serverId !== this.serverId) return;
      runInAction(() => {
        for (const chat of chats) this.upsert(chat);
      });
    } catch (error) {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.listError = failureText(error, 'Your chats could not be listed.');
      });
    }
  }

  private relisting = false;

  private async relist(serverId: string): Promise<void> {
    if (this.relisting) return;
    this.relisting = true;
    try {
      const chats = await this.api.list(serverId);
      if (serverId !== this.serverId) return;
      runInAction(() => {
        for (const chat of chats) if (!this.chats.has(chat.roomId)) this.upsert(chat);
      });
    } catch (error) {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.listError = failureText(error, 'Your chats could not be listed.');
      });
    } finally {
      this.relisting = false;
    }
  }

  remove(roomId: string, reason: ChatRemovalReason): void {
    this.chats.delete(roomId);
    if (reason === 'unlisted') {
      this.unlisted.add(roomId);
      return;
    }
    this.unlisted.delete(roomId);
    this.archived.delete(roomId);
    this.removed.add(roomId);
    if (this.serverId) {
      const timeline = this.timelines.peek(this.serverId, roomId);
      if (timeline) timeline.revoke();
    }
  }

  reset(serverId: string): void {
    this.timelines.dropServer(serverId);
    if (serverId !== this.serverId) return;
    this.chats = new Map();
    this.removed = new Set();
    this.unlisted = new Set();
    this.archived = new Map();
    this.archivedError = null;
    this.userId = null;
    this.tenantId = null;
    void this.connect(serverId);
  }

  /** Drops an agent the server removed from the chat as it stands now, not as it stood when the removal was asked for. */
  dropAgent(roomId: string, agentId: string): void {
    const chat = this.chats.get(roomId);
    if (chat)
      this.chats.set(roomId, {
        ...chat,
        agents: chat.agents.filter((agent) => agent.id !== agentId),
      });
  }

  /** Which room's chat is on screen and being read; null when none is. */
  setViewing(roomId: string | null): void {
    this.viewing = roomId;
  }

  /**
   * The chat was shown through message `seq`: its count goes to 0 here at once,
   * and the position reaches the server once reading settles. Never backwards.
   */
  read(roomId: string, seq: number): void {
    const serverId = this.serverId;
    if (!serverId) return;
    const chat = this.chats.get(roomId);
    if (chat && chat.unreadCount !== 0) this.chats.set(roomId, { ...chat, unreadCount: 0 });
    const furthest = Math.max(this.readThrough.get(roomId) ?? 0, this.readPending.get(roomId) ?? 0);
    if (furthest >= seq) return;
    this.readPending.set(roomId, seq);
    clearTimeout(this.readTimers.get(roomId));
    this.readTimers.set(
      roomId,
      setTimeout(() => {
        this.readTimers.delete(roomId);
        this.api.markRead(serverId, roomId, seq).then(
          () => {
            this.readThrough.set(roomId, Math.max(this.readThrough.get(roomId) ?? 0, seq));
            if (this.readPending.get(roomId) === seq) this.readPending.delete(roomId);
          },
          () => {
            if (this.readPending.get(roomId) === seq) this.readPending.delete(roomId);
          }
        );
      }, READ_DEBOUNCE_MS)
    );
  }

  /** How many messages in a room wait to be read: none for the one being read. */
  unread(roomId: string): number {
    return this.viewing === roomId ? 0 : (this.chats.get(roomId)?.unreadCount ?? 0);
  }

  /** The chats an agent is in, newest activity first. */
  chatsOfAgent(agentId: string): ChatSummary[] {
    return [...this.chats.values()]
      .filter((chat) => chat.agents.some((agent) => agent.id === agentId))
      .sort((a, b) => (b.lastMessage?.sentAt ?? '').localeCompare(a.lastMessage?.sentAt ?? ''));
  }

  /** The archived chats an agent is in, newest activity first. */
  archivedOfAgent(agentId: string): ChatSummary[] {
    return [...this.archived.values()]
      .filter((chat) => chat.agents.some((agent) => agent.id === agentId))
      .sort((a, b) => (b.lastMessage?.sentAt ?? '').localeCompare(a.lastMessage?.sentAt ?? ''));
  }

  /** A listed chat, or an archived one. */
  chat(roomId: string): ChatSummary | undefined {
    return this.chats.get(roomId) ?? this.archived.get(roomId);
  }
}

/** The events the store listens to, from the typed renderer event bus. */
export function chatsEventsFrom(bus: {
  on: <T>(event: { name: string; _data?: T }, cb: (data: T) => void) => () => void;
}): ChatsEvents {
  return {
    onMessage: (cb) => bus.on(chatMessageChannel, cb),
    onSummary: (cb) => bus.on(chatSummaryChannel, cb),
    onRemoved: (cb) => bus.on(chatRemovedChannel, cb),
    onState: (cb) => bus.on(chatStreamStateChannel, cb),
    onReset: (cb) => bus.on(chatResetChannel, cb),
  };
}
