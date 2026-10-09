import { makeAutoObservable, reaction, runInAction } from 'mobx';
import { failureText } from '@renderer/lib/errors/describe-failure';
import {
  chatMessageChannel,
  chatRemovedChannel,
  chatResetChannel,
  chatStreamStateChannel,
  chatSummaryChannel,
} from '@shared/core/chats/chatEvents';
import type { ChatMessage, ChatStreamState, ChatSummary } from '@shared/core/chats/chats';
import { ChatTimelines, type TimelineApi } from './chat-timeline-store';

/**
 * The signed-in person's chats on the server the window is scoped to, kept
 * live by the main process's feed, and the timelines of the chats opened.
 *
 * A reset (sign-out, tenant switch) drops everything held for the server; a
 * removal drops the room's messages and marks it lost, so an open chat can
 * say so instead of quietly emptying.
 */

export type ChatsApi = {
  connect: (serverId: string) => Promise<{ state: ChatStreamState; detail: string | null }>;
  list: (serverId: string) => Promise<ChatSummary[]>;
  identity: (serverId: string) => Promise<{ userId: string; tenantId: string | null }>;
  timeline: (serverId: string) => TimelineApi;
};

export type ChatsEvents = {
  onMessage: (cb: (data: { serverId: string; message: ChatMessage }) => void) => () => void;
  onSummary: (cb: (data: { serverId: string; chat: ChatSummary }) => void) => () => void;
  onRemoved: (cb: (data: { serverId: string; roomId: string }) => void) => () => void;
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
  streamState: ChatStreamState = 'offline';
  streamDetail: string | null = null;
  listError: string | null = null;
  readonly timelines: ChatTimelines;

  constructor(
    private readonly api: ChatsApi,
    events: ChatsEvents
  ) {
    this.timelines = new ChatTimelines(api.timeline);
    makeAutoObservable<ChatsStore, 'api'>(this, { api: false, timelines: false });
    events.onSummary(({ serverId, chat }) => {
      if (serverId === this.serverId) this.upsert(chat);
    });
    events.onMessage(({ serverId, message }) => this.message(serverId, message));
    events.onRemoved(({ serverId, roomId }) => {
      if (serverId === this.serverId) this.remove(roomId);
    });
    events.onState(({ serverId, state, detail }) => {
      if (serverId !== this.serverId) return;
      runInAction(() => {
        this.streamState = state;
        this.streamDetail = detail;
      });
    });
    events.onReset(({ serverId }) => this.reset(serverId));
  }

  /** Follow the server the window is scoped to; `key` changes with the workspace. */
  follow(read: () => { serverId: string | null; key: string | null }): () => void {
    return reaction(read, ({ serverId }) => void this.connect(serverId), {
      fireImmediately: true,
      equals: (a, b) => a.serverId === b.serverId && a.key === b.key,
    });
  }

  async connect(serverId: string | null): Promise<void> {
    if (serverId !== this.serverId) {
      runInAction(() => {
        this.serverId = serverId;
        this.chats = new Map();
        this.removed = new Set();
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
      if (serverId !== this.serverId) return;
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
  }

  upsert(chat: ChatSummary): void {
    this.chats.set(chat.roomId, chat);
    this.removed.delete(chat.roomId);
    if (this.serverId) this.timelines.peek(this.serverId, chat.roomId)?.restore();
  }

  /** A chat the person made or was let into from here, ahead of the feed. */
  add(serverId: string, chat: ChatSummary): void {
    if (serverId === this.serverId) this.upsert(chat);
  }

  /** Hidden by the person: off the list until a newer message brings it back. */
  hide(roomId: string): void {
    this.chats.delete(roomId);
  }

  message(serverId: string, message: ChatMessage): void {
    if (serverId !== this.serverId) return;
    this.timelines.peek(serverId, message.roomId)?.apply(message);
    const chat = this.chats.get(message.roomId);
    // The feed follows hidden chats too; a message in one is what brings it back.
    if (!chat && !this.removed.has(message.roomId)) void this.relist(serverId);
    if (chat && (chat.lastMessage === null || chat.lastMessage.seq < message.seq))
      this.chats.set(message.roomId, {
        ...chat,
        lastMessage: {
          seq: message.seq,
          sentAt: message.sentAt,
          preview: message.body.slice(0, 200),
          senderName: message.sender.name,
        },
      });
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

  remove(roomId: string): void {
    this.chats.delete(roomId);
    this.removed.add(roomId);
    if (this.serverId) this.timelines.peek(this.serverId, roomId)?.revoke();
  }

  reset(serverId: string): void {
    this.timelines.dropServer(serverId);
    if (serverId !== this.serverId) return;
    this.chats = new Map();
    this.removed = new Set();
    this.userId = null;
    this.tenantId = null;
    void this.connect(serverId);
  }

  /** The chats an agent is in, newest activity first. */
  chatsOfAgent(agentId: string): ChatSummary[] {
    return [...this.chats.values()]
      .filter((chat) => chat.agents.some((agent) => agent.id === agentId))
      .sort((a, b) => (b.lastMessage?.sentAt ?? '').localeCompare(a.lastMessage?.sentAt ?? ''));
  }

  chat(roomId: string): ChatSummary | undefined {
    return this.chats.get(roomId);
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
