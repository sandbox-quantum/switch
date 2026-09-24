import { randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { open, readFile, rename, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const HANDOFF_FILE = 'handoff.jsonl';
export const COMMAND_WAKE_FILE = 'commands.wake';

/** A lossy wakeup only. Commands stay in Core until the worker acknowledges them. */
export async function wakeCommands(root: string): Promise<void> {
  await writeFile(join(root, COMMAND_WAKE_FILE), randomUUID(), { mode: 0o600 });
}
export const APPROVALS_WAKE_FILE = 'approvals.wake';

/** A lossy wakeup only. Outcomes stay owed in Core until the worker says they are delivered. */
export async function wakeApprovals(root: string): Promise<void> {
  await writeFile(join(root, APPROVALS_WAKE_FILE), randomUUID(), { mode: 0o600 });
}
export const CAPABILITY_FILE = 'worker.json';
const NEWLINE = 0x0a;

/**
 * One routed event, numbered in the agent's inbound event sequence.
 *
 * A session no longer has a connection of its own to number it against: the
 * agent has one, the controller reads it, and the same numbering is what
 * Switch answers a session's own ask for its room work in. So an event that
 * arrives both ways is recognisably one event.
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
 * file. Switch holds the delivery reserved for the session either way, so an
 * event handed to a worker that does not read it is not the last copy going
 * missing — the session asks for its own room work and is offered it again.
 * What it is is a delivery this route did not make while the controller
 * counted it made, so the room waits on the slower one with nobody saying why.
 * Bumping this number is how a later protocol stops an older worker being
 * routed to.
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
  const file = await open(join(root, HANDOFF_FILE), 'a+', 0o600);
  try {
    await discardTornRecord(file);
    await file.writeFile(`${JSON.stringify(handoffSchema.parse(event))}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}

/**
 * A controller killed mid-append leaves a record with no terminator, which the
 * next append would run onto the end of. The writer is the only party that
 * knows those bytes were abandoned rather than damaged, so it is the one that
 * drops them — leaving the reader free to treat anything it cannot read as
 * damage. The bytes discarded are a record that was never completed, so nothing
 * that reached the journal is lost with them.
 */
async function discardTornRecord(file: FileHandle): Promise<void> {
  const { size } = await file.stat();
  if (size === 0) return;
  const tail = Buffer.alloc(1);
  const { bytesRead } = await file.read(tail, 0, 1, size - 1);
  if (bytesRead !== 1 || tail[0] === NEWLINE) return;
  const complete = await lastRecordEnd(file, size);
  console.warn(
    `Discarding ${size - complete} unfinished bytes at the end of ${HANDOFF_FILE}; the controller that began that record did not finish it.`
  );
  await file.truncate(complete);
}

/** Where the last complete record ends, which is where a reader's position sits. */
async function lastRecordEnd(file: FileHandle, size: number): Promise<number> {
  const chunk = Buffer.alloc(Math.min(size, 8192));
  for (let end = size; end > 0; end -= chunk.byteLength) {
    const length = Math.min(chunk.byteLength, end);
    const filled = await readFully(file, chunk, length, end - length);
    const at = chunk.subarray(0, filled).lastIndexOf(NEWLINE);
    if (at !== -1) return end - length + at + 1;
  }
  return 0;
}

/**
 * Reads `length` bytes from `position`. A read is allowed to return less than
 * it was asked for, and the rest of the file is on disk rather than lost, so
 * what it returns is what was actually read — never what was requested. Both
 * ends of this file depend on that: the reader advances its position by it, and
 * the writer decides where to truncate by it.
 */
async function readFully(
  file: FileHandle,
  buffer: Buffer,
  length: number,
  position: number
): Promise<number> {
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await file.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return filled;
}

/**
 * The worker's end of the handoff: what the controller has appended since the
 * last read. Written by one process and read by another, so the position only
 * ever moves to the end of a complete record — a write still in flight is read
 * again, whole, on the next pass.
 */
export class HandoffInbox {
  private offset = 0;
  private appended = false;
  private commands = false;
  private approvals = false;

  takeCommandWake(): boolean {
    const pending = this.commands;
    this.commands = false;
    return pending;
  }

  takeApprovalWake(): boolean {
    const pending = this.approvals;
    this.approvals = false;
    return pending;
  }
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
        if (filename === null || filename === COMMAND_WAKE_FILE) {
          this.commands = true;
          this.wake?.();
        }
        if (filename === null || filename === APPROVALS_WAKE_FILE) {
          this.approvals = true;
          this.wake?.();
        }
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
      if (this.appended || this.commands || this.approvals) return resolve();
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
      const filled = await readFully(file, buffer, buffer.byteLength, this.offset);
      const complete = buffer.subarray(0, filled).lastIndexOf(NEWLINE) + 1;
      this.offset += complete;
      return records(buffer.subarray(0, complete));
    } finally {
      await file.close();
    }
  }
}

/**
 * Splits on the record terminator before decoding, so a character that spanned
 * two reads is decoded from its own bytes rather than twice in halves. Every
 * line here is terminated, and the writer drops a record it abandoned before
 * appending the next, so a line that will not read is damage and is refused
 * rather than skipped past.
 */
function records(complete: Buffer): Handoff[] {
  const handoffs: Handoff[] = [];
  let start = 0;
  for (
    let end = complete.indexOf(NEWLINE, start);
    end !== -1;
    end = complete.indexOf(NEWLINE, start)
  ) {
    const line = complete.subarray(start, end).toString('utf8');
    start = end + 1;
    if (!line) continue;
    handoffs.push(handoffSchema.parse(JSON.parse(line)));
  }
  return handoffs;
}
