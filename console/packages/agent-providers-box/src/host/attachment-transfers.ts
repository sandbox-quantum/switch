import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { MAX_ATTACHMENT_BYTES, stageAttachment } from './attachments';
import { sharedSessionRoot } from './launch';

/**
 * Console uploads reaching a session through its sidecar or watcher: chunked,
 * idempotent per `(transferId, index)`, checked against the declared digest,
 * then staged in the session's root under a fresh `ref` that a `message.send`
 * names as its attachment id.
 */

export const MAX_CHUNK_BYTES = 1024 * 1024;
const MAX_TRANSFERS = 4;
const MAX_STAGED_BYTES = 32 * 1024 * 1024;
export const TRANSFER_IDLE_MS = 120_000;
export const STAGED_UNCONSUMED_MS = 10 * 60_000;

export const attachmentChunkSchema = z.object({
  transferId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  sessionId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  index: z.number().int().nonnegative(),
  count: z.number().int().positive(),
  chunk: z.string(),
});
export type AttachmentChunk = z.infer<typeof attachmentChunkSchema>;

/** A refusal with a code a caller can act on. */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ControlError';
  }
}

type Transfer = {
  chunk: Omit<AttachmentChunk, 'index' | 'chunk'>;
  next: number;
  received: number;
  touchedAt: number;
};

type Staged = { directory: string; size: number; stagedAt: number };

export class AttachmentTransfers {
  private readonly partials = new Map<string, Transfer>();
  private readonly staged = new Map<string, Staged>();
  private readonly consumed = new Set<string>();
  private readonly completed = new Map<string, string>();
  private serial: Promise<unknown> = Promise.resolve();

  constructor(private readonly root: string) {}

  private get directory(): string {
    return join(this.root, 'relay-attachments');
  }

  /** Drop every partial transfer, as at start and on a generation change. */
  async clear(): Promise<void> {
    this.partials.clear();
    await rm(this.directory, { recursive: true, force: true });
  }

  async cancel(transferId: string): Promise<void> {
    this.partials.delete(transferId);
    await rm(join(this.directory, `${transferId}.part`), { force: true });
  }

  /** Delete partial transfers idle past their window and staged files nothing consumed. */
  async sweep(now: number): Promise<void> {
    for (const [transferId, partial] of this.partials)
      if (now - partial.touchedAt >= TRANSFER_IDLE_MS) await this.cancel(transferId);
    for (const [ref, staged] of this.staged)
      if (now - staged.stagedAt >= STAGED_UNCONSUMED_MS) {
        this.staged.delete(ref);
        for (const [transferId, completed] of this.completed)
          if (completed === ref) this.completed.delete(transferId);
        await rm(staged.directory, { recursive: true, force: true });
      }
  }

  /**
   * Take the staged refs a command names. An id that is not a ref is a Switch
   * attachment and passes; a ref already consumed is refused.
   */
  consume(attachmentIds: string[]): void {
    for (const id of attachmentIds)
      if (this.consumed.has(id))
        throw new ControlError('attachment_consumed', `Attachment ${id} was already sent.`);
    for (const id of attachmentIds) if (this.staged.delete(id)) this.consumed.add(id);
  }

  /** One chunk; chunks are taken one at a time. */
  receive(
    chunk: AttachmentChunk
  ): Promise<{ next: number } | { staged: { transferId: string; ref: string } }> {
    const received = this.serial.then(() => this.take(chunk));
    this.serial = received.catch(() => {});
    return received;
  }

  private async take(
    chunk: AttachmentChunk
  ): Promise<{ next: number } | { staged: { transferId: string; ref: string } }> {
    await this.sweep(Date.now());
    const done = this.completed.get(chunk.transferId);
    if (done !== undefined) return { staged: { transferId: chunk.transferId, ref: done } };
    const { index, chunk: encoded, ...meta } = chunk;
    let partial = this.partials.get(chunk.transferId);
    if (!partial) {
      if (index !== 0)
        throw new ControlError(
          'out_of_order',
          `Transfer ${chunk.transferId} is unknown; start it at chunk 0.`,
          { expected: 0 }
        );
      try {
        await stat(join(sharedSessionRoot(chunk.sessionId), 'config.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          throw new ControlError('not_found', `Session ${chunk.sessionId} is not on this host.`);
        throw error;
      }
      const stagedBytes = [...this.staged.values(), ...this.partials.values()].reduce(
        (total, entry) => total + ('size' in entry ? entry.size : entry.chunk.size),
        0
      );
      if (
        this.partials.size + this.staged.size >= MAX_TRANSFERS ||
        stagedBytes + chunk.size > MAX_STAGED_BYTES
      )
        throw new ControlError(
          'staging_full',
          'Too many attachments are being staged; retry shortly.'
        );
      partial = { chunk: meta, next: 0, received: 0, touchedAt: Date.now() };
      this.partials.set(chunk.transferId, partial);
    } else if (JSON.stringify(partial.chunk) !== JSON.stringify(meta))
      throw new ControlError(
        'invalid_chunk',
        `Chunk ${index} does not match transfer ${chunk.transferId}.`
      );
    partial.touchedAt = Date.now();
    if (index < partial.next) return { next: partial.next };
    if (index > partial.next)
      throw new ControlError('out_of_order', `Expected chunk ${partial.next}, got ${index}.`, {
        expected: partial.next,
      });
    const data = Buffer.from(encoded, 'base64');
    const part = join(this.directory, `${chunk.transferId}.part`);
    if (
      data.byteLength > MAX_CHUNK_BYTES ||
      partial.received + data.byteLength > chunk.size ||
      index >= chunk.count
    ) {
      await this.cancel(chunk.transferId);
      throw new ControlError(
        'invalid_chunk',
        `Chunk ${index} exceeds transfer ${chunk.transferId}.`
      );
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await appendFile(part, data, { mode: 0o600 });
    partial.received += data.byteLength;
    partial.next += 1;
    if (partial.next < chunk.count) return { next: partial.next };
    const file = await readFile(part);
    const sha256 = createHash('sha256').update(file).digest('hex');
    if (file.byteLength !== chunk.size || sha256 !== chunk.sha256) {
      await this.cancel(chunk.transferId);
      throw new ControlError(
        'digest_mismatch',
        `Transfer ${chunk.transferId} does not match its size and digest.`
      );
    }
    const ref = randomUUID();
    const sessionRoot = sharedSessionRoot(chunk.sessionId);
    try {
      await stageAttachment(
        sessionRoot,
        {
          attachmentId: ref,
          name: chunk.name,
          mimeType: chunk.mimeType,
          bytes: chunk.size,
          sha256,
        },
        async () => ({ data: file, sha256 })
      );
    } finally {
      await this.cancel(chunk.transferId);
    }
    this.staged.set(ref, {
      directory: join(sessionRoot, 'attachments', createHash('sha256').update(ref).digest('hex')),
      size: chunk.size,
      stagedAt: Date.now(),
    });
    this.completed.set(chunk.transferId, ref);
    return { staged: { transferId: chunk.transferId, ref } };
  }
}
