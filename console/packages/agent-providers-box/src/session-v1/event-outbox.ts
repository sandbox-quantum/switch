import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { HostBody, HostEvent } from '@switch-console/shared/session-v1';
import { parseHostEvent } from '@switch-console/shared/session-v1';

/** Append-only journal. A successful append has been fsynced before returning. */
export class EventOutbox {
  private readonly events: HostEvent[] = [];
  private acknowledged = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private failed = false;

  private constructor(
    private readonly path: string,
    private readonly sessionId: string,
    private readonly epoch: string
  ) {}

  static async load(path: string, sessionId: string, epoch: string): Promise<EventOutbox> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, 'a', 0o600);
    await handle.close();
    const outbox = new EventOutbox(path, sessionId, epoch);
    const text = await readFile(path, 'utf8');
    if (text && !text.endsWith('\n'))
      throw new Error('Incomplete outbox record; recovery is required.');
    for (const line of text.split('\n').filter(Boolean)) {
      const record: unknown = JSON.parse(line);
      if (record !== null && typeof record === 'object' && 'acknowledged' in record) {
        outbox.checkAck(record.acknowledged);
        outbox.acknowledged = record.acknowledged as number;
      } else {
        const event = parseHostEvent(record);
        if (
          event.sessionId !== sessionId ||
          event.epoch !== epoch ||
          event.hostSequence !== outbox.events.length + 1
        )
          throw new Error('Outbox identity or sequence mismatch.');
        outbox.events.push(event);
      }
    }
    return outbox;
  }

  append(body: HostBody, occurredAt: string): Promise<HostEvent> {
    return this.serialize(async () => {
      const event = parseHostEvent({
        contractVersion: 1,
        eventId: randomUUID(),
        sessionId: this.sessionId,
        epoch: this.epoch,
        hostSequence: this.events.length + 1,
        occurredAt,
        body,
      });
      await this.write(event);
      this.events.push(event);
      return structuredClone(event);
    });
  }

  acknowledge(sequence: number): Promise<void> {
    return this.serialize(async () => {
      this.checkAck(sequence);
      if (sequence === this.acknowledged) return;
      await this.write({ acknowledged: sequence });
      this.acknowledged = sequence;
    });
  }

  pending(): HostEvent[] {
    return structuredClone(this.events.slice(this.acknowledged));
  }

  private checkAck(sequence: unknown): void {
    if (
      typeof sequence !== 'number' ||
      !Number.isSafeInteger(sequence) ||
      sequence < this.acknowledged ||
      sequence > this.events.length
    )
      throw new Error('Invalid outbox acknowledgement.');
  }

  private async write(record: unknown): Promise<void> {
    const handle = await open(this.path, 'a', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`);
      await handle.sync();
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      await handle.close();
    }
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(() => {
      if (this.failed) throw new Error('Outbox write failed; reload before continuing.');
      return operation();
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
