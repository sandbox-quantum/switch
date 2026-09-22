import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const HANDOFF_FILE = 'handoff.jsonl';
const CAPABILITY_FILE = 'worker.json';

/**
 * One routed event, in the sequence numbering the controller's connection and
 * the session's own connection share.
 */
export const handoffSchema = z.strictObject({
  sequence: z.number().int().positive(),
  roomId: z.string().min(1),
  messageId: z.string().min(1),
});
export type Handoff = z.infer<typeof handoffSchema>;

/**
 * The handoff protocol a worker in this state root understands.
 *
 * A controller routes to a worker only where the worker has said it reads this
 * file, because the inbox is the only place a routed event exists: a worker
 * that does not read it would leave the event unadmitted, and the commands
 * endpoint only ever returns commands something already admitted, so the
 * message would go nowhere and report nothing. Bumping this number is how a
 * later protocol stops an older worker being routed to.
 */
export const HANDOFF_PROTOCOL = 1;
const capabilitySchema = z.object({ handoff: z.number().int().nonnegative() });

/**
 * Say that this worker reads handoffs, for the controller sharing its state
 * root. Left in place when the worker stops: the same root is next opened by
 * this bundle or a newer one, and an event handed over while it was down is
 * read when it starts.
 */
export async function declareHandoffCapability(root: string): Promise<void> {
  const path = join(root, CAPABILITY_FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ handoff: HANDOFF_PROTOCOL }), { mode: 0o600 });
  await rename(temporary, path);
}

/** Whether the worker in this state root reads what a controller hands it. */
export async function readsHandoffs(root: string): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(join(root, CAPABILITY_FILE), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  let written: unknown = null;
  try {
    written = JSON.parse(text);
  } catch {
    written = null;
  }
  const declared = capabilitySchema.safeParse(written);
  if (!declared.success) {
    console.warn(
      `Session ${root} declares a worker capability this controller cannot read; routing it the way an older worker is routed.`
    );
    return false;
  }
  return declared.data.handoff >= HANDOFF_PROTOCOL;
}

/**
 * Hand a routed event to the worker serving that room. Appended before the
 * worker is started or woken, so a controller that dies in between has already
 * made the decision durable. Handing the same event over twice is harmless —
 * the worker drops an event it has already recorded, which it must do anyway
 * while its own connection can see the same one.
 */
export async function handOff(root: string, event: Handoff): Promise<void> {
  const file = await open(join(root, HANDOFF_FILE), 'a', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(handoffSchema.parse(event))}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * The worker's end of the handoff: what the controller has appended since the
 * last read. Written by one process and read by another, so a trailing partial
 * line is a write in flight rather than damage, and is held until the rest of
 * it lands.
 */
export class HandoffInbox {
  private offset = 0;
  private partial = '';
  private appended = false;
  private watcher: FSWatcher | null = null;
  private wake: (() => void) | null = null;

  constructor(private readonly root: string) {}

  /**
   * Notice the controller appending, so what a routed message waits for stops
   * being the loop's poll interval.
   *
   * The file is created by the controller and may not exist yet, so the state
   * root is watched rather than the path. A watch that cannot be established
   * or dies is reported and left dead: the loop still polls, which is how
   * every message reached a session before this, so the cost is the wait back
   * rather than the message.
   */
  listen(signal: AbortSignal): void {
    if (this.watcher || signal.aborted) return;
    const close = () => {
      this.watcher?.close();
      this.watcher = null;
    };
    try {
      this.watcher = watch(this.root, (_event, filename) => {
        // A null filename is the platform declining to say what changed.
        if (filename !== null && filename !== HANDOFF_FILE) return;
        this.appended = true;
        this.wake?.();
      });
    } catch (error) {
      console.warn(`Cannot watch for controller handoffs; polling for them instead: ${error}`);
      return;
    }
    this.watcher.on('error', (error: Error) => {
      console.warn(`Controller handoff watch failed; polling for them instead: ${error.message}`);
      close();
    });
    signal.addEventListener('abort', close, { once: true });
  }

  /**
   * Waits out the loop's poll interval, or returns as soon as the controller
   * has handed something over.
   */
  idle(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (this.appended) return resolve();
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        this.wake = null;
        if (error) reject(error);
        else resolve();
      };
      const onAbort = () => finish(signal.reason);
      const timer = setTimeout(finish, ms);
      this.wake = finish;
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  async drain(): Promise<Handoff[]> {
    // Cleared before the read, so an append landing during it is still a wake.
    this.appended = false;
    let file;
    try {
      file = await open(join(this.root, HANDOFF_FILE), 'r');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    try {
      const { size } = await file.stat();
      if (size < this.offset)
        throw new Error('The controller handoff journal shrank; recovery review is required.');
      if (size === this.offset) return [];
      const buffer = Buffer.alloc(size - this.offset);
      await file.read(buffer, 0, buffer.byteLength, this.offset);
      this.offset = size;
      const lines = (this.partial + buffer.toString('utf8')).split('\n');
      this.partial = lines.pop()!;
      return lines.filter(Boolean).map((line) => handoffSchema.parse(JSON.parse(line)));
    } finally {
      await file.close();
    }
  }
}
