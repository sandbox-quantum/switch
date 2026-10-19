import { log } from '@main/lib/logger';
import {
  type ChatActivityItem,
  chatActivityItemSchema,
  type ChatApproval,
  chatApprovalSchema,
  SERVER_TOO_OLD_FOR_ACTIVITY,
} from '@shared/core/chats/activity';
import type { ChatStreamState } from '@shared/core/chats/chats';
import { sseFrames, STALL_MS } from './chat-stream';

/**
 * The server's activity feed (`GET /chats/activity/events`): turn steps and
 * approval requests of every room the person may read. It has no cursor, so
 * every `ready` (first connect and each reconnect) and every `resync` tells
 * the renderer to reload its rooms' snapshots; rows it already holds are
 * kept or replaced by revision.
 */

export type ChatActivitySink = {
  activity: (item: ChatActivityItem) => void;
  approval: (approval: ChatApproval) => void;
  resync: () => void;
  /** `offline` when the feed drops, with why; `live` once it is back. */
  state: (state: ChatStreamState, detail: string | null) => void;
};

export type ChatActivityStreamDeps = {
  open: (signal: AbortSignal) => Promise<Response>;
  isUnauthorized: (error: unknown) => boolean;
  sink: ChatActivitySink;
  backoffMs: (attempt: number) => number;
  setTimer: (fn: () => void, ms: number) => () => void;
};

export class ChatActivityStream {
  private stopped = false;
  private running = false;
  private abort: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;
  private attempt = 0;
  /** A server without the feed: not asked again until the next `start`. */
  private tooOld = false;
  private current: { state: ChatStreamState; detail: string | null } = {
    state: 'connecting',
    detail: null,
  };

  constructor(private readonly deps: ChatActivityStreamDeps) {}

  get state(): { state: ChatStreamState; detail: string | null } {
    return this.current;
  }

  private setState(state: ChatStreamState, detail: string | null): void {
    this.current = { state, detail };
    this.deps.sink.state(state, detail);
  }

  start(): void {
    this.stopped = false;
    if (this.running) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.attempt = 0;
    this.tooOld = false;
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped) {
        try {
          await this.connectOnce();
          throw new Error('The server closed the activity feed.');
        } catch (error) {
          if (this.stopped) return;
          const detail = this.tooOld
            ? SERVER_TOO_OLD_FOR_ACTIVITY
            : error instanceof Error
              ? error.message
              : String(error);
          log.warn('Chat activity feed dropped; agent activity may lag until it reconnects', {
            event: 'chat_activity_stream_offline',
            error: detail,
          });
          this.setState('offline', detail);
          if (this.tooOld || this.deps.isUnauthorized(error)) return;
          const wait = this.deps.backoffMs(this.attempt++);
          await new Promise<void>((resolve) => {
            this.cancelTimer = this.deps.setTimer(() => {
              this.cancelTimer = null;
              resolve();
            }, wait);
          });
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async connectOnce(): Promise<void> {
    const abort = new AbortController();
    this.abort = abort;
    const stall = { cancel: (): void => {} };
    const armStall = () => {
      stall.cancel();
      stall.cancel = this.deps.setTimer(() => abort.abort(), STALL_MS);
    };
    try {
      armStall();
      const response = await this.deps.open(abort.signal);
      this.tooOld = response.status === 404;
      if (!response.ok) throw new Error(`The activity feed was refused (${response.status}).`);
      if (!response.body) throw new Error('The activity feed has no body.');
      for await (const frame of sseFrames(
        response.body as unknown as AsyncIterable<Uint8Array>,
        armStall
      )) {
        if (this.stopped) return;
        try {
          this.handle(frame.event, frame.data);
        } catch (error) {
          log.warn('Skipped a chat activity event that does not match the contract', {
            event: 'chat_activity_event_invalid',
            frameEvent: frame.event,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      stall.cancel();
      if (this.abort === abort) this.abort = null;
    }
  }

  private handle(event: string, data: string): void {
    switch (event) {
      case 'ready':
        this.attempt = 0;
        this.setState('live', null);
        this.deps.sink.resync();
        return;
      case 'resync':
        this.deps.sink.resync();
        return;
      case 'activity':
        this.deps.sink.activity(chatActivityItemSchema.parse(JSON.parse(data)));
        return;
      case 'approval':
        this.deps.sink.approval(chatApprovalSchema.parse(JSON.parse(data)));
        return;
      default:
        return;
    }
  }
}
