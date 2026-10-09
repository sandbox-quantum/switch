import { makeAutoObservable, runInAction } from 'mobx';
import {
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
  mentionAgentId: string | null;
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
  mentionAgentId: string | null;
  files: ChatFile[];
};

export type TimelineApi = {
  messages: (roomId: string, beforeSeq: number | null, limit: number) => Promise<ChatMessagesPage>;
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
      mentionAgentId: string | null;
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
  /** The person is not a member of the room. */
  notMember = false;
  /** The person was a member and lost access while the chat was known. */
  accessLost = false;
  /**
   * A message sent while the agent's cloud machine sleeps: the room has it,
   * and the chat says it waits for the machine. Kept here so it outlives
   * navigating away.
   */
  held: { since: number } | null = null;

  constructor(
    readonly roomId: string,
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

  /** Merge a message from the room: by sequence, once, retiring the send it echoes. */
  apply(message: ChatMessage): void {
    if (message.roomId !== this.roomId) return;
    const requestId = requestIdOfClientTxn(message.clientTxn);
    if (requestId) this.pending = this.pending.filter((send) => send.requestId !== requestId);
    if (this.messages.some((each) => each.seq === message.seq)) return;
    const at = this.messages.findIndex((each) => each.seq > message.seq);
    if (at === -1) this.messages.push(message);
    else this.messages.splice(at, 0, message);
  }

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    this.loadError = null;
    try {
      const page = await this.api.messages(this.roomId, null, PAGE_SIZE);
      runInAction(() => {
        for (const message of page.messages) this.apply(message);
        if (!this.loaded) this.hasMore = page.hasMore;
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
      });
    } catch (error) {
      runInAction(() => {
        this.loadError = chatFailure(error).message;
      });
    } finally {
      runInAction(() => {
        this.loading = false;
      });
    }
  }

  /** Send a message; returns its request id. */
  send(input: SendInput): string {
    const send: PendingSend = {
      requestId: this.api.newId(),
      body: input.body,
      threadRootId: input.threadRootId,
      mentionAgentId: input.mentionAgentId,
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

  setHeld(held: boolean): void {
    this.held = held ? (this.held ?? { since: Date.now() }) : null;
  }

  /** The person lost access: nothing held for the room is theirs to see any more. */
  revoke(): void {
    this.accessLost = true;
    this.messages = [];
    this.pending = [];
    this.held = null;
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
        uploadIds: send.files.map((file) => file.uploadId),
        mentionAgentId: send.mentionAgentId,
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

  constructor(private readonly api: (serverId: string) => TimelineApi) {}

  get(serverId: string, roomId: string): ChatTimeline {
    const key = `${serverId}\u0000${roomId}`;
    let timeline = this.timelines.get(key);
    if (!timeline) {
      timeline = new ChatTimeline(roomId, this.api(serverId));
      this.timelines.set(key, timeline);
    }
    return timeline;
  }

  peek(serverId: string, roomId: string): ChatTimeline | undefined {
    return this.timelines.get(`${serverId}\u0000${roomId}`);
  }

  /** Forget everything held for a server: signed out, or the tenant changed. */
  dropServer(serverId: string): void {
    for (const key of [...this.timelines.keys()])
      if (key.startsWith(`${serverId}\u0000`)) this.timelines.delete(key);
  }
}
