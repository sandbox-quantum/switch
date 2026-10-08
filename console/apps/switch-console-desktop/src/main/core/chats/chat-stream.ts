import {
  type ChatMessage,
  chatMessageSchema,
  chatRemovedSchema,
  type ChatStreamState,
  type ChatSummary,
  chatSummarySchema,
} from '@shared/core/chats/chats';

/**
 * One live feed of a person's chats on one server and tenant.
 *
 * Connecting reads the chat list first and takes each room's newest sequence
 * as its cursor, then opens `GET /chats/events?after=room:seq,…`. The server
 * catches every room up from its cursor and says `ready`; only then is the
 * feed `live`. A dropped feed reconnects with backoff from the cursors it
 * reached, so nothing between is lost and nothing already delivered is
 * delivered again. Pings carry no meaning beyond "the connection is alive":
 * a feed silent for longer than {@link STALL_MS} is treated as dropped.
 */

export const STALL_MS = 60_000;

export type ChatStreamSink = {
  message: (message: ChatMessage) => void;
  summary: (chat: ChatSummary) => void;
  removed: (roomId: string) => void;
  state: (state: ChatStreamState, detail: string | null) => void;
};

export type ChatStreamDeps = {
  listChats: () => Promise<ChatSummary[]>;
  /** Open the event stream; the response body is read until it ends. */
  open: (after: string, signal: AbortSignal) => Promise<Response>;
  /** Whether a failure means the person is signed out, so retrying cannot help. */
  isUnauthorized: (error: unknown) => boolean;
  sink: ChatStreamSink;
  /** Delay before reconnect attempt `attempt` (0-based). */
  backoffMs: (attempt: number) => number;
  setTimer: (fn: () => void, ms: number) => () => void;
};

export function defaultBackoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt);
}

type Frame = { event: string; data: string };

/** Server-sent event frames from a byte stream; `onChunk` fires for every chunk, pings included. */
export async function* sseFrames(
  body: AsyncIterable<Uint8Array>,
  onChunk: () => void
): AsyncGenerator<Frame> {
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of body) {
    onChunk();
    buffered += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let at = buffered.indexOf('\n\n');
    while (at !== -1) {
      const block = buffered.slice(0, at);
      buffered = buffered.slice(at + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith(':')) continue;
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
      at = buffered.indexOf('\n\n');
    }
  }
}

class StreamClosed extends Error {}

export class ChatStream {
  private readonly cursors = new Map<string, number>();
  private stopped = false;
  private running = false;
  private abort: AbortController | null = null;
  private cancelTimer: (() => void) | null = null;
  private attempt = 0;
  private current: { state: ChatStreamState; detail: string | null } = {
    state: 'connecting',
    detail: null,
  };

  constructor(private readonly deps: ChatStreamDeps) {}

  get state(): { state: ChatStreamState; detail: string | null } {
    return this.current;
  }

  /** The sequence each room has been delivered through. */
  cursor(roomId: string): number | undefined {
    return this.cursors.get(roomId);
  }

  /** Start, or reconnect now if the feed is waiting to retry or gave up. */
  start(): void {
    this.stopped = false;
    if (this.running) return;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.attempt = 0;
    void this.loop();
  }

  /** Drop the connection and reconnect from the cursors reached. */
  resync(): void {
    if (this.stopped) return;
    this.abort?.abort();
    if (!this.running) this.start();
  }

  stop(): void {
    this.stopped = true;
    this.cancelTimer?.();
    this.cancelTimer = null;
    this.abort?.abort();
    this.abort = null;
  }

  private setState(state: ChatStreamState, detail: string | null): void {
    if (this.current.state === state && this.current.detail === detail) return;
    this.current = { state, detail };
    this.deps.sink.state(state, detail);
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopped) {
        try {
          await this.connectOnce();
          throw new Error('The server closed the live feed.');
        } catch (error) {
          if (this.stopped) return;
          const detail = error instanceof Error ? error.message : String(error);
          if (this.deps.isUnauthorized(error)) {
            this.setState('offline', detail);
            return;
          }
          this.setState('offline', detail);
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

  private afterParam(): string {
    return [...this.cursors].map(([roomId, seq]) => `${roomId}:${seq}`).join(',');
  }

  private async connectOnce(): Promise<void> {
    this.setState('connecting', null);
    const chats = await this.deps.listChats();
    if (this.stopped) return;
    for (const chat of chats) {
      if (!this.cursors.has(chat.roomId)) this.cursors.set(chat.roomId, chat.lastMessage?.seq ?? 0);
      this.deps.sink.summary(chat);
    }
    const abort = new AbortController();
    this.abort = abort;
    const stall = { cancel: (): void => {} };
    const armStall = () => {
      stall.cancel();
      stall.cancel = this.deps.setTimer(() => abort.abort(), STALL_MS);
    };
    try {
      armStall();
      const response = await this.deps.open(this.afterParam(), abort.signal);
      if (!response.ok) throw new Error(`The live feed was refused (${response.status}).`);
      if (!response.body) throw new Error('The live feed has no body.');
      this.setState('catching-up', null);
      for await (const frame of sseFrames(
        response.body as unknown as AsyncIterable<Uint8Array>,
        armStall
      )) {
        if (this.stopped) return;
        this.handle(frame);
      }
    } catch (error) {
      if (abort.signal.aborted && !this.stopped)
        throw new StreamClosed('The live feed stalled or was restarted.');
      throw error;
    } finally {
      stall.cancel();
      if (this.abort === abort) this.abort = null;
    }
  }

  private handle(frame: Frame): void {
    const data: unknown = JSON.parse(frame.data);
    switch (frame.event) {
      case 'message': {
        const message = chatMessageSchema.parse(data);
        const cursor = this.cursors.get(message.roomId);
        if (cursor !== undefined && message.seq <= cursor) return;
        this.cursors.set(message.roomId, message.seq);
        this.deps.sink.message(message);
        return;
      }
      case 'chat': {
        const chat = chatSummarySchema.parse(data);
        this.deps.sink.summary(chat);
        return;
      }
      case 'chat.removed': {
        const { roomId } = chatRemovedSchema.parse(data);
        this.cursors.delete(roomId);
        this.deps.sink.removed(roomId);
        return;
      }
      case 'ready':
        this.attempt = 0;
        this.setState('live', null);
        return;
      default:
        return;
    }
  }
}
