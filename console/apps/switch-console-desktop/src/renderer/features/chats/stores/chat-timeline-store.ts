import { makeAutoObservable, observable, runInAction } from 'mobx';
import {
  type ChatMentionSpan,
  type ChatMessage,
  type ChatMessagesPage,
  type ChatUpload,
  requestIdOfClientTxn,
} from '@shared/core/chats/chats';
import { chatFailure } from './chat-errors';

/**
 * One chat's messages as the room holds them, by sequence, and the sends the
 * person made from here that the room has not echoed yet.
 *
 * A send is identified by its request id from the moment it is made: a retry
 * reuses it, so the server applies it at most once however often it is asked,
 * and the echo (`clientTxn` = `{requestId}:{i}`) is what retires it. A send
 * whose outcome is unknown stays visible as such — it is never resent on its
 * own, and never dropped as if it had failed.
 */

export const PAGE_SIZE = 50;

export type ChatFile = {
  name: string;
  type: string;
  size: number;
  /** The bytes, base64. */
  read: () => Promise<string>;
};

export type PendingFile = {
  id: string;
  /** Stable across retries: the upload is idempotent per upload id. */
  uploadId: string;
  file: ChatFile;
  state: 'waiting' | 'uploading' | 'uploaded' | 'refused';
  error: string | null;
};

export type PendingSend = {
  requestId: string;
  body: string;
  threadRootId: string | null;
  mentionAgentIds: string[];
  mentionUserIds: string[];
  mentionSpans: ChatMentionSpan[];
  files: PendingFile[];
  state: 'sending' | 'failed' | 'conflict';
  error: string | null;
  /** The server may have taken it: only a retry with the same request id is safe. */
  uncertain: boolean;
  /** The message itself was posted at least once (not just its files). */
  posted: boolean;
};

export type SendInput = {
  body: string;
  threadRootId: string | null;
  /** The agents picked as mentions; the server adds `@name` for any the body does not name. */
  mentionAgentIds: string[];
  /** The people picked as mentions; they are told, and no agent is addressed by them. */
  mentionUserIds: string[];
  /** Each picked or matched mention's stretch of the body and whom it names. */
  mentionSpans: ChatMentionSpan[];
  files: ChatFile[];
  /** The request id an earlier send of this same message used, when it may have landed; null for a new one. */
  requestId: string | null;
};

export type TimelineApi = {
  messages: (roomId: string, beforeSeq: number | null, limit: number) => Promise<ChatMessagesPage>;
  threadMessages: (
    roomId: string,
    rootId: string,
    beforeSeq: number | null,
    limit: number
  ) => Promise<ChatMessage[]>;
  upload: (
    roomId: string,
    file: { uploadId: string; name: string; mimeType: string; data: string }
  ) => Promise<ChatUpload>;
  send: (
    roomId: string,
    input: {
      requestId: string;
      body: string;
      threadRootId: string | null;
      uploadIds: string[];
      mentionAgentIds?: string[];
      mentionUserIds?: string[];
      mentionSpans?: ChatMentionSpan[];
    }
  ) => Promise<ChatMessage[]>;
  newId: () => string;
};

export class ChatTimeline {
  messages: ChatMessage[] = [];
  pending: PendingSend[] = [];
  hasMore = false;
  loaded = false;
  loading = false;
  loadError: string | null = null;
  /** The failure in {@link loadError} was loading earlier messages, not the newest. */
  olderFailed = false;
  /** A load was asked for while another was in flight; it runs once that one ends. */
  private reloadQueued = false;
  /** History is held without gaps through this sequence: the newest a successful load read. */
  private completeThrough: number | null = null;
  /** The person is not a member of the room. */
  notMember = false;
  /** The person was a member and lost access while the chat was known. */
  accessLost = false;
  /** Thread reply counts by root message id, tracked from live events even if root not loaded. */
  threadReplyCounts = new Map<string, number>();

  constructor(
    /** Changes once, from an unsaved chat's id to its room's when the room is made. */
    public roomId: string,
    private readonly api: TimelineApi
  ) {
    makeAutoObservable<ChatTimeline, 'api'>(this, { api: false, roomId: false });
  }

  get newestSeq(): number | null {
    return this.messages.at(-1)?.seq ?? null;
  }

  byId(messageId: string): ChatMessage | undefined {
    return this.messages.find((message) => message.messageId === messageId);
  }

  /** Thread reply count: server baseline + distinct live replies since, or null if root not loaded. */
  threadReplyCount(rootId: string): number | null {
    const root = this.byId(rootId);
    if (!root) return null;
    const serverCount = root.threadReplyCount ?? 0;
    const lastReplySeq = root.threadLastReplySeq ?? -1;
    const newReplies = this.messages.filter(
      (msg) => msg.threadRootId === rootId && msg.seq > lastReplySeq
    );
    const uniqueNewReplies = new Set(newReplies.map((m) => m.messageId)).size;
    return serverCount + uniqueNewReplies;
  }

  /** Load thread messages for a root. */
  async loadThread(rootId: string, beforeSeq: number | null = null): Promise<ChatMessage[]> {
    try {
      return await this.api.threadMessages(this.roomId, rootId, beforeSeq, PAGE_SIZE);
    } catch (error) {
      throw chatFailure(error);
    }
  }

  /** Merge a message from the room: by sequence, once, retiring the send it echoes. */
  apply(message: ChatMessage): void {
    if (message.roomId !== this.roomId) return;
    const requestId = requestIdOfClientTxn(message.clientTxn);
    if (requestId) this.pending = this.pending.filter((send) => send.requestId !== requestId);
    if (this.messages.some((each) => each.seq === message.seq)) return;
    const at = this.messages.findIndex((each) => each.seq > message.seq);
    if (at === -1) this.messages.push(message);
    else this.messages.splice(at, 0, message);
    if (message.threadRootId) {
      const current = this.threadReplyCounts.get(message.threadRootId) ?? 0;
      this.threadReplyCounts.set(message.threadRootId, current + 1);
    }
  }

  async load(): Promise<void> {
    if (this.loading) {
      this.reloadQueued = true;
      return;
    }
    this.loading = true;
    this.loadError = null;
    this.olderFailed = false;
    const held = this.completeThrough;
    try {
      let page = await this.api.messages(this.roomId, null, PAGE_SIZE);
      const fetched = [...page.messages];
      const newest = page.messages.length
        ? Math.max(...page.messages.map((message) => message.seq))
        : (held ?? 0);
      // Page back to the history already complete, so a gap since the last load is not skipped.
      let oldest = Math.min(...page.messages.map((message) => message.seq));
      while (held !== null && page.hasMore && page.messages.length && oldest > held) {
        page = await this.api.messages(this.roomId, oldest, PAGE_SIZE);
        fetched.push(...page.messages);
        oldest = Math.min(oldest, ...page.messages.map((message) => message.seq));
      }
      runInAction(() => {
        for (const message of fetched) this.apply(message);
        // A catch-up that stopped short of what was held left earlier messages to load.
        if (!this.loaded || (held !== null && oldest > held)) this.hasMore = page.hasMore;
        this.completeThrough = newest;
        this.loaded = true;
        this.notMember = false;
      });
    } catch (error) {
      const failure = chatFailure(error);
      runInAction(() => {
        if (failure.kind === 'not-a-member') this.notMember = true;
        else this.loadError = failure.message;
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.load();
      }
    }
  }

  async loadOlder(): Promise<void> {
    const oldest = this.messages[0]?.seq ?? null;
    if (this.loading || !this.hasMore || oldest === null) return;
    this.loading = true;
    try {
      const page = await this.api.messages(this.roomId, oldest, PAGE_SIZE);
      runInAction(() => {
        for (const message of page.messages) this.apply(message);
        this.hasMore = page.hasMore;
        this.loadError = null;
        this.olderFailed = false;
      });
    } catch (error) {
      runInAction(() => {
        this.loadError = chatFailure(error).message;
        this.olderFailed = true;
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
      if (this.reloadQueued) {
        this.reloadQueued = false;
        void this.load();
      }
    }
  }

  /** Ask again for what last failed to load. */
  retryLoad(): void {
    void (this.olderFailed ? this.loadOlder() : this.load());
  }

  /** Send a message; returns its request id. */
  send(input: SendInput): string {
    const send: PendingSend = {
      requestId: input.requestId ?? this.api.newId(),
      body: input.body,
      threadRootId: input.threadRootId,
      mentionAgentIds: input.mentionAgentIds,
      mentionUserIds: input.mentionUserIds,
      mentionSpans: input.mentionSpans,
      files: input.files.map((file) => ({
        id: this.api.newId(),
        uploadId: this.api.newId(),
        file,
        state: 'waiting',
        error: null,
      })),
      state: 'sending',
      error: null,
      uncertain: false,
      posted: false,
    };
    this.pending.push(send);
    void this.attempt(send.requestId);
    return send.requestId;
  }

  /** Ask again with the same request id and the same files. */
  retry(requestId: string): void {
    const send = this.find(requestId);
    if (!send || send.state === 'sending') return;
    void this.attempt(requestId);
  }

  /**
   * Drop the files the server refused and send the rest. Only before the
   * message was posted: a posted request id names its payload for good.
   */
  dropRefusedFiles(requestId: string): void {
    const send = this.find(requestId);
    if (!send || send.posted || send.state === 'sending') return;
    send.files = send.files.filter((file) => file.state !== 'refused');
    void this.attempt(requestId);
  }

  discard(requestId: string): void {
    this.pending = this.pending.filter((send) => send.requestId !== requestId);
  }

  /** The person lost access: nothing held for the room is theirs to see any more. */
  revoke(): void {
    this.accessLost = true;
    this.messages = [];
    this.completeThrough = null;
    this.pending = [];
  }

  /** Access came back: read the room again from scratch. */
  restore(): void {
    if (!this.accessLost && !this.notMember) return;
    this.accessLost = false;
    this.notMember = false;
    this.loaded = false;
    this.loadError = null;
  }

  private find(requestId: string): PendingSend | undefined {
    return this.pending.find((send) => send.requestId === requestId);
  }

  private async attempt(requestId: string): Promise<void> {
    const send = this.find(requestId);
    if (!send) return;
    runInAction(() => {
      send.state = 'sending';
      send.error = null;
    });
    await Promise.all(
      send.files
        .filter((file) => file.state !== 'uploaded')
        .map(async (file) => {
          runInAction(() => {
            file.state = 'uploading';
            file.error = null;
          });
          try {
            await this.api.upload(this.roomId, {
              uploadId: file.uploadId,
              name: file.file.name,
              mimeType: file.file.type || 'application/octet-stream',
              data: await file.file.read(),
            });
            runInAction(() => {
              file.state = 'uploaded';
            });
          } catch (error) {
            const failure = chatFailure(error);
            runInAction(() => {
              file.state = 'refused';
              file.error = failure.message;
            });
            if (failure.kind === 'not-a-member') runInAction(() => this.revoke());
          }
        })
    );
    if (!this.find(requestId)) return;
    const refused = send.files.filter((file) => file.state === 'refused');
    if (refused.length) {
      runInAction(() => {
        send.state = 'failed';
        send.error =
          refused.length === 1
            ? `${refused[0]!.file.name} could not be attached: ${refused[0]!.error}`
            : `${refused.length} files could not be attached.`;
      });
      return;
    }
    try {
      runInAction(() => {
        send.posted = true;
      });
      const messages = await this.api.send(this.roomId, {
        requestId,
        body: send.body,
        threadRootId: send.threadRootId,
        // A copy: IPC cannot clone a MobX array.
        mentionAgentIds: [...send.mentionAgentIds],
        mentionUserIds: [...send.mentionUserIds],
        mentionSpans: send.mentionSpans.map((span) => ({ ...span })),
        uploadIds: send.files.map((file) => file.uploadId),
      });
      runInAction(() => {
        for (const message of messages) this.apply(message);
        this.discard(requestId);
      });
    } catch (error) {
      const failure = chatFailure(error);
      runInAction(() => {
        if (failure.kind === 'not-a-member') {
          this.revoke();
          return;
        }
        send.state = failure.kind === 'request-reused' ? 'conflict' : 'failed';
        send.error = failure.message;
        send.uncertain = failure.uncertain;
      });
    }
  }
}

/**
 * The timelines of every chat opened since the server's feed was last reset,
 * by server and room: they, and the sends in them, outlive the view showing
 * them.
 */
export class ChatTimelines {
  private readonly timelines = new Map<string, ChatTimeline>();
  /**
   * The keys opened, observable, so what reads a room's messages through
   * {@link peek} follows a timeline opened later. Told after the call that opened
   * it, which is a view rendering: changing what other views observe while one
   * renders is what React refuses.
   */
  private readonly opened = observable.set<string>();

  constructor(private readonly api: (serverId: string) => TimelineApi) {}

  get(serverId: string, roomId: string): ChatTimeline {
    const key = `${serverId}\u0000${roomId}`;
    let timeline = this.timelines.get(key);
    if (!timeline) {
      timeline = new ChatTimeline(roomId, this.api(serverId));
      this.timelines.set(key, timeline);
      queueMicrotask(() => runInAction(() => this.opened.add(key)));
    }
    return timeline;
  }

  /**
   * The timeline of a chat whose room does not exist yet: nothing to load, and
   * its first upload or send makes the room through `create` before going to it.
   */
  unsaved(serverId: string, roomId: string, create: () => Promise<string>): ChatTimeline {
    const api = this.api(serverId);
    const room = (id: string) => (id === roomId ? create() : Promise.resolve(id));
    const key = `${serverId}\u0000${roomId}`;
    const timeline = new ChatTimeline(roomId, {
      ...api,
      messages: (id, beforeSeq, limit) =>
        id === roomId
          ? Promise.resolve({ messages: [], headSeq: 0, hasMore: false })
          : api.messages(id, beforeSeq, limit),
      upload: async (id, file) => api.upload(await room(id), file),
      send: async (id, input) => api.send(await room(id), input),
    });
    runInAction(() => {
      timeline.loaded = true;
    });
    this.timelines.set(key, timeline);
    queueMicrotask(() => runInAction(() => this.opened.add(key)));
    return timeline;
  }

  /** The unsaved chat's room was made: its timeline, sends in flight and all, is that room's now. */
  rekey(serverId: string, from: string, to: string): void {
    const timeline = this.timelines.get(`${serverId}\u0000${from}`);
    if (!timeline) return;
    this.timelines.delete(`${serverId}\u0000${from}`);
    timeline.roomId = to;
    this.timelines.set(`${serverId}\u0000${to}`, timeline);
    runInAction(() => {
      this.opened.delete(`${serverId}\u0000${from}`);
      this.opened.add(`${serverId}\u0000${to}`);
    });
  }

  peek(serverId: string, roomId: string): ChatTimeline | undefined {
    const key = `${serverId}\u0000${roomId}`;
    this.opened.has(key);
    return this.timelines.get(key);
  }

  /** Load again each of the server's timelines that loaded, is loading or failed to, catching up to the live feed. */
  reload(serverId: string): void {
    for (const [key, timeline] of this.timelines)
      if (
        key.startsWith(`${serverId}\u0000`) &&
        (timeline.loaded || timeline.loading || timeline.loadError)
      )
        void timeline.load();
  }

  /** Forget everything held for a server: signed out, or the tenant changed. */
  dropServer(serverId: string): void {
    for (const key of [...this.timelines.keys()])
      if (key.startsWith(`${serverId}\u0000`)) this.timelines.delete(key);
    runInAction(() => {
      for (const key of [...this.opened])
        if (key.startsWith(`${serverId}\u0000`)) this.opened.delete(key);
    });
  }
}
