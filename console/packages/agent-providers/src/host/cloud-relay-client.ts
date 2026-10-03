import { createHash, randomUUID } from 'node:crypto';
import {
  type Attachment,
  serverEventSchema,
  type ServerEvent,
  type Session,
  sessionSchema,
  type Snapshot,
  snapshotSchema,
} from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { MAX_CHUNK_BYTES } from './attachment-transfers';
import { MAX_ATTACHMENT_BYTES } from './attachments';
import type { ControlMessage } from './control';
import {
  SessionHostFailedError,
  SessionUnavailableError,
  type SessionRequest,
} from './session-channel';
import { type PlaceOutcome, type WatcherHealth, watcherHealthSchema } from './watcher-tools';

/**
 * Console's end of a cloud worker's sessions, relayed through Switch.
 *
 * A cloud worker accepts no inbound connection, so where a sidecar is reached
 * over its loopback control port this goes through the Switch gateway: one
 * `POST …/relay` per request, answered by the worker's watcher, and one
 * `GET …/relay/stream` per live view. The messages are the control
 * vocabulary's (`ControlMessage`), and the methods are `ControlClient`'s, so
 * the callers of either do not tell them apart. Large answers arrive in pages
 * and are reassembled here; attachments go up in chunks.
 */

/** One call to the launch's relay routes; `path` is relative to the launch. */
export type RelayFetch = (
  path: string,
  init: { method: 'GET' | 'POST'; body: unknown; signal: AbortSignal }
) => Promise<Response>;

/** A relay the worker or Switch refused, with the code Console acts on. */
export class CloudRelayError extends Error {
  constructor(
    readonly relayCode: string,
    message: string,
    readonly status: number,
    readonly wakeAvailable: boolean
  ) {
    super(message);
    this.name = 'CloudRelayError';
  }
}

export class CloudRelayClosedError extends Error {
  constructor(reason: string) {
    super(`The relay to the cloud worker closed: ${reason}`);
    this.name = 'CloudRelayClosedError';
  }
}

/** The longest a relay may wait for the worker, as Switch allows it. */
export const RELAY_TIMEOUT_MS = 30_000;
const PAGED_ATTEMPTS = 3;
const CHUNK_ATTEMPTS = 3;

/** Nothing was sent to the worker: asking again cannot act twice. */
const RETRYABLE = new Set(['worker_waking', 'worker_not_attached', 'worker_busy', 'snapshot_busy']);
const RESTART_PAGED = new Set(['snapshot_expired', 'snapshot_superseded', 'generation_changed']);

const replySchema = z.object({
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
  wake_available: z.boolean().optional(),
});

const firstPageSchema = z.object({
  snapshotId: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  pageCount: z.number().int().positive(),
  page: z.object({ index: z.literal(0), data: z.string() }),
});
const pageSchema = z.object({
  snapshotId: z.string().min(1),
  page: z.object({ index: z.number().int().positive(), data: z.string() }),
});

const workerFrameSchema = z.object({
  launch_revision: z.number().nullable(),
  boot_id: z.string().nullable(),
  generation: z.number().nullable(),
});
const eventFrameSchema = z.object({ sessionId: z.string(), event: z.unknown() });
const failureFrameSchema = z.object({ sessionId: z.string(), failure: z.string().nullable() });
const healthFrameSchema = z.object({ health: watcherHealthSchema });
const resyncFrameSchema = z.object({ sessionId: z.string().nullable(), reason: z.string() });
const errorFrameSchema = z.object({
  sessionId: z.string().nullable(),
  code: z.string(),
  message: z.string(),
});

const placeOutcomeSchema = z.object({
  sessionId: z.string(),
  roomId: z.string(),
  previous: z.string().nullable(),
  displaced: z.string().nullable(),
});
const chunkAnswerSchema = z.union([
  z.object({ next: z.number().int().nonnegative() }),
  z.object({ staged: z.object({ transferId: z.string(), ref: z.string().min(1) }) }),
]);

const MUTATING = ['place', 'forget', 'attachment', 'attachmentCancel'];

function mutating(message: ControlMessage): boolean {
  if ('request' in message) return message.request.type === 'command';
  return MUTATING.some((key) => key in message);
}

/** The worker's refusal as the error `ControlClient` raises for the same case. */
function refusal(code: string, message: string, status: number, wakeAvailable: boolean): Error {
  if (code === 'session_unavailable') return new SessionUnavailableError(message);
  if (code === 'session_failed')
    return new SessionHostFailedError(message.replace(/^The session host failed: /, ''));
  return new CloudRelayError(code, message, status, wakeAvailable);
}

async function readReply(response: Response): Promise<z.infer<typeof replySchema>> {
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new CloudRelayError(
      'http',
      `Switch answered the relay with ${response.status}: ${text.slice(0, 500)}`,
      response.status,
      false
    );
  }
  const reply = replySchema.safeParse(body);
  if (reply.success) return reply.data;
  const detail = z.object({ detail: z.unknown() }).safeParse(body);
  if (response.status === 404)
    throw new CloudRelayError('not_found', 'Cloud launch not found.', 404, false);
  throw new CloudRelayError(
    'http',
    `Switch answered the relay with ${response.status}: ${JSON.stringify(detail.success ? detail.data.detail : body).slice(0, 500)}`,
    response.status,
    false
  );
}

type Frame = { event: string; data: unknown };

/** Server-sent events from a streaming response, one `{event, data}` per frame. */
export async function* relayFrames(response: Response): AsyncGenerator<Frame> {
  if (!response.body) throw new Error('The relay stream has no body.');
  const decoder = new TextDecoder();
  let buffered = '';
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
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
      if (data.length) yield { event, data: JSON.parse(data.join('\n')) };
      at = buffered.indexOf('\n\n');
    }
  }
}

type RelayStream = { ready: Promise<void>; close: () => void };

export type CloudRelayOptions = {
  /** How long a request keeps asking while the worker is starting or its queue is full. */
  retryMs: number;
  /** How long the worker has to answer one request, at most `RELAY_TIMEOUT_MS`. */
  timeoutMs: number;
};

export class CloudRelayClient {
  private closed: Error | null = null;
  private readonly closeListeners = new Set<(error: Error) => void>();
  private readonly healthListeners = new Set<(health: WatcherHealth) => void>();
  private healthStream: RelayStream | null = null;
  private readonly views = new Set<(reason: string) => void>();

  constructor(
    private readonly fetchRelay: RelayFetch,
    private readonly options: CloudRelayOptions
  ) {
    if (options.timeoutMs > RELAY_TIMEOUT_MS)
      throw new Error(`A relay waits at most ${RELAY_TIMEOUT_MS} ms.`);
  }

  get isClosed(): boolean {
    return this.closed !== null;
  }

  private async once(message: ControlMessage): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchRelay('/relay', {
        method: 'POST',
        body: { message, timeout_ms: this.options.timeoutMs },
        signal: AbortSignal.timeout(this.options.timeoutMs + 15_000),
      });
    } catch (error) {
      throw new CloudRelayError(
        'unreachable',
        `Switch could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        0,
        false
      );
    }
    const reply = await readReply(response);
    if (reply.ok) return reply.value ?? null;
    const code = reply.error?.code ?? 'failed';
    throw refusal(
      code,
      reply.error?.message ?? 'The cloud worker refused the request.',
      response.status,
      reply.wake_available === true
    );
  }

  /** One relayed message, asked again while the worker cannot have received it. */
  private async call(message: ControlMessage): Promise<unknown> {
    if (this.closed) throw this.closed;
    const deadline = Date.now() + this.options.retryMs;
    let pause = 250;
    for (;;) {
      try {
        return await this.once(message);
      } catch (error) {
        const again =
          error instanceof CloudRelayError &&
          (RETRYABLE.has(error.relayCode) ||
            (error.relayCode === 'generation_changed' && !mutating(message)));
        if (!again || Date.now() + pause > deadline) throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, pause));
      pause = Math.min(pause * 2, 2000);
    }
  }

  /** A paged answer, reassembled and checked against its size and digest. */
  private async paged(message: ControlMessage): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        const first = firstPageSchema.parse(await this.call(message));
        const parts = [Buffer.from(first.page.data, 'base64')];
        for (let index = 1; index < first.pageCount; index++) {
          const next = pageSchema.parse(
            await this.call({ page: { snapshotId: first.snapshotId, index } })
          );
          if (next.snapshotId !== first.snapshotId || next.page.index !== index)
            throw new Error(`The cloud worker answered page ${index} with another page.`);
          parts.push(Buffer.from(next.page.data, 'base64'));
        }
        const data = Buffer.concat(parts);
        const sha256 = createHash('sha256').update(data).digest('hex');
        if (data.byteLength !== first.bytes || sha256 !== first.sha256)
          throw new Error('A paged answer from the cloud worker does not match its digest.');
        return JSON.parse(data.toString('utf8')) as unknown;
      } catch (error) {
        const restart =
          error instanceof CloudRelayError &&
          RESTART_PAGED.has(error.relayCode) &&
          attempt < PAGED_ATTEMPTS;
        if (!restart) throw error;
      }
    }
  }

  /** A session request; a snapshot comes back whole however many pages it took. */
  async request(sessionId: string, request: SessionRequest): Promise<unknown> {
    const message = { sessionId, request };
    return request.type === 'snapshot' ? this.paged(message) : this.call(message);
  }

  /** The agent's sessions on the worker, as their hosts recorded them. */
  async list(): Promise<Session[]> {
    return z.array(sessionSchema).parse(await this.paged({ list: true }));
  }

  /** A session read from its journal on the worker, whether or not its host runs. */
  async journal(sessionId: string): Promise<Snapshot> {
    return snapshotSchema.parse(await this.paged({ journal: sessionId }));
  }

  async place(sessionId: string, roomId: string): Promise<PlaceOutcome> {
    return placeOutcomeSchema.parse(await this.call({ place: { sessionId, roomId } }));
  }

  async forget(sessionId: string): Promise<void> {
    await this.call({ forget: sessionId });
  }

  async health(): Promise<WatcherHealth> {
    return watcherHealthSchema.parse(await this.call({ health: true }));
  }

  /**
   * Upload a file to the session's worker in chunks and stage it there. The
   * attachment it returns is named by a `message.send`, which consumes it.
   */
  async uploadAttachment(
    sessionId: string,
    file: { name: string; mimeType: string; data: Uint8Array }
  ): Promise<Attachment> {
    const size = file.data.byteLength;
    if (size === 0) throw new Error(`${file.name} is empty.`);
    if (size > MAX_ATTACHMENT_BYTES)
      throw new Error(`${file.name} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MiB.`);
    const sha256 = createHash('sha256').update(file.data).digest('hex');
    const count = Math.ceil(size / MAX_CHUNK_BYTES);
    const transferId = randomUUID();
    try {
      for (let index = 0; index < count; index++) {
        const chunk = Buffer.from(
          file.data.subarray(index * MAX_CHUNK_BYTES, (index + 1) * MAX_CHUNK_BYTES)
        ).toString('base64');
        const message = {
          attachment: {
            transferId,
            sessionId,
            name: file.name,
            mimeType: file.mimeType,
            size,
            sha256,
            index,
            count,
            chunk,
          },
        };
        let answer: z.infer<typeof chunkAnswerSchema> | null = null;
        for (let attempt = 1; answer === null; attempt++) {
          try {
            answer = chunkAnswerSchema.parse(await this.call(message));
          } catch (error) {
            // A chunk is idempotent per index, so one whose reply was lost is sent again.
            const lost =
              error instanceof CloudRelayError &&
              error.relayCode === 'relay_timeout' &&
              attempt < CHUNK_ATTEMPTS;
            if (!lost) throw error;
          }
        }
        if ('staged' in answer) {
          if (index !== count - 1)
            throw new Error(`The cloud worker staged ${file.name} before its last chunk.`);
          return {
            attachmentId: answer.staged.ref,
            name: file.name,
            mimeType: file.mimeType,
            bytes: size,
            sha256,
          };
        }
        if (answer.next !== index + 1)
          throw new Error(
            `The cloud worker expected chunk ${answer.next} of ${file.name} after chunk ${index}.`
          );
      }
      throw new Error(`The cloud worker did not stage ${file.name} after its last chunk.`);
    } catch (error) {
      // The worker also drops a partial transfer after two idle minutes.
      await this.call({ attachmentCancel: transferId }).catch(() => undefined);
      throw error;
    }
  }

  private stream(
    query: string,
    onFrame: (frame: Frame) => void,
    onEnd: (error: Error) => void
  ): RelayStream {
    const abort = new AbortController();
    let settle!: { resolve: () => void; reject: (error: Error) => void };
    const ready = new Promise<void>((resolve, reject) => {
      settle = { resolve, reject };
    });
    let opened = false;
    void (async () => {
      const response = await this.fetchRelay(`/relay/stream?${query}`, {
        method: 'GET',
        body: undefined,
        signal: abort.signal,
      });
      if (!response.ok) {
        const reply = await readReply(response);
        throw refusal(
          reply.error?.code ?? 'failed',
          reply.error?.message ?? `The relay stream was refused (${response.status}).`,
          response.status,
          reply.wake_available === true
        );
      }
      for await (const frame of relayFrames(response)) {
        if (!opened && frame.event === 'worker') {
          opened = true;
          settle.resolve();
        }
        onFrame(frame);
      }
      throw new CloudRelayClosedError('Switch ended the stream.');
    })().catch((error: unknown) => {
      if (abort.signal.aborted) return;
      const failure = error instanceof Error ? error : new CloudRelayClosedError(String(error));
      if (opened) onEnd(failure);
      else settle.reject(failure);
    });
    return { ready, close: () => abort.abort() };
  }

  /**
   * Hear every event the session's host records, and `onFailure` whenever it
   * stops on a failure or comes up again. `onReset` is called once, instead
   * of any further event, when the live view can no longer be trusted: the
   * worker changed, Switch reported a gap or an overflow, or the stream
   * closed. The view is then rebuilt from a new snapshot.
   *
   * Resolves once Switch holds the view, so a snapshot asked for after it
   * misses nothing the view does not also carry.
   */
  async subscribe(
    sessionId: string,
    listener: (event: ServerEvent) => void,
    onFailure: (failure: string | null) => void,
    onReset: (reason: string) => void
  ): Promise<() => void> {
    if (this.closed) throw this.closed;
    let worker: string | null = null;
    let done = false;
    const reset = (reason: string) => {
      if (done) return;
      done = true;
      this.views.delete(reset);
      stream.close();
      onReset(reason);
    };
    const stream = this.stream(
      new URLSearchParams({ subscribe: sessionId }).toString(),
      (frame) => {
        if (done) return;
        switch (frame.event) {
          case 'worker': {
            const current = JSON.stringify(workerFrameSchema.parse(frame.data));
            if (worker === null) worker = current;
            else if (worker !== current) reset('The cloud worker changed.');
            return;
          }
          case 'event': {
            const parsed = serverEventSchema.safeParse(eventFrameSchema.parse(frame.data).event);
            if (parsed.success) listener(parsed.data);
            else reset(`The cloud worker sent an unreadable event: ${parsed.error.message}`);
            return;
          }
          case 'failure':
            onFailure(failureFrameSchema.parse(frame.data).failure);
            return;
          case 'resync':
            reset(`Switch asked for a resync (${resyncFrameSchema.parse(frame.data).reason}).`);
            return;
          case 'error': {
            const error = errorFrameSchema.parse(frame.data);
            reset(`${error.message} (${error.code})`);
            return;
          }
        }
      },
      (error) => reset(error.message)
    );
    this.views.add(reset);
    try {
      await stream.ready;
    } catch (error) {
      done = true;
      this.views.delete(reset);
      throw error;
    }
    return () => {
      done = true;
      this.views.delete(reset);
      stream.close();
    };
  }

  /**
   * Called with the watcher's state whenever it changes. The stream behind it
   * ending, or the worker changing under it, closes this client.
   */
  async onHealth(listener: (health: WatcherHealth) => void): Promise<() => void> {
    if (this.closed) throw this.closed;
    this.healthListeners.add(listener);
    if (!this.healthStream) {
      let worker: string | null = null;
      const stream = this.stream(
        'watchHealth=1',
        (frame) => {
          if (frame.event === 'worker') {
            const current = JSON.stringify(workerFrameSchema.parse(frame.data));
            if (worker === null) worker = current;
            else if (worker !== current)
              this.fail(new CloudRelayClosedError('the cloud worker changed.'));
          } else if (frame.event === 'health') {
            const { health } = healthFrameSchema.parse(frame.data);
            for (const each of this.healthListeners) each(health);
          } else if (frame.event === 'resync' || frame.event === 'error')
            this.fail(new CloudRelayClosedError(JSON.stringify(frame.data)));
        },
        (error) => this.fail(error)
      );
      this.healthStream = stream;
      try {
        await stream.ready;
      } catch (error) {
        this.healthStream = null;
        this.healthListeners.delete(listener);
        throw error;
      }
    }
    return () => {
      if (!this.healthListeners.delete(listener) || this.healthListeners.size) return;
      this.healthStream?.close();
      this.healthStream = null;
    };
  }

  onClose(listener: (error: Error) => void): () => void {
    if (this.closed) {
      listener(this.closed);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    this.healthStream?.close();
    this.healthStream = null;
    for (const reset of [...this.views]) reset(error.message);
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
  }

  close(): void {
    this.fail(new CloudRelayClosedError('closed by Console.'));
  }
}
