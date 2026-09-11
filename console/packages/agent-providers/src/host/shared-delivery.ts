import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { hostEventSchema } from '@switch-console/shared/session-v1';
import type { HostBody, HostEvent, ServerEvent, Session } from '@switch-console/shared/session-v1';
import { z } from 'zod';
import { Journal } from './journal';

const recordSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('event'),
    sourceSequence: z.number().int().positive(),
    event: hostEventSchema.nullable(),
  }),
  z.strictObject({ type: z.literal('ack'), sequence: z.number().int().nonnegative() }),
]);

/** The source cursor and its wire event become durable in the same write. */
export class SharedDelivery {
  private sourceSequence = 0;
  private acknowledged = 0;
  private readonly events: HostEvent[] = [];

  private constructor(
    private readonly journal: Journal<z.infer<typeof recordSchema>>,
    private readonly session: Session,
    sourceBase: number
  ) {
    this.sourceSequence = sourceBase;
    for (const record of journal.records) {
      if (record.type === 'event') {
        if (record.sourceSequence !== this.sourceSequence + 1)
          throw new Error('Shared delivery journal has a gap in its source cursor.');
        this.sourceSequence = record.sourceSequence;
        if (record.event) {
          if (
            record.event.sessionId !== session.sessionId ||
            record.event.epoch !== session.epoch ||
            record.event.hostSequence !== this.events.length + 1
          )
            throw new Error('Shared delivery journal has an invalid event identity or sequence.');
          this.events.push({ ...record.event, body: this.currentGeneration(record.event.body) });
        }
      } else {
        this.validateAck(record.sequence);
        this.acknowledged = record.sequence;
      }
    }
  }

  static async load(root: string, session: Session, sourceBase = 0): Promise<SharedDelivery> {
    const journal = await Journal.load(
      join(root, `delivery-${createHash('sha256').update(session.epoch).digest('hex')}.jsonl`),
      (value) => recordSchema.parse(value)
    );
    return new SharedDelivery(journal, session, sourceBase);
  }

  get throughHostSequence(): number {
    return this.events.length;
  }

  get cursor(): number {
    return this.sourceSequence;
  }

  pending(): HostEvent[] {
    return structuredClone(this.events.slice(this.acknowledged));
  }

  async capture(source: ServerEvent): Promise<void> {
    if (source.sequence !== this.sourceSequence + 1)
      throw new Error('Shared delivery source sequence is not contiguous.');
    let body: HostBody | null;
    if (source.body.type === 'command.status') {
      const { status } = source.body;
      body =
        status === 'applied' || status === 'rejected' || status === 'unknown'
          ? { ...source.body, type: 'command.result', status }
          : null;
    } else if (
      source.body.type === 'request.submitting' ||
      source.body.type === 'session.connectivity'
    )
      body = null;
    else body = this.currentGeneration(source.body);
    const event = body
      ? hostEventSchema.parse({
          contractVersion: 1,
          eventId: source.eventId,
          sessionId: this.session.sessionId,
          epoch: this.session.epoch,
          hostSequence: this.events.length + 1,
          occurredAt: source.occurredAt,
          body,
        })
      : null;
    await this.journal.append({ type: 'event', sourceSequence: source.sequence, event });
    this.sourceSequence = source.sequence;
    if (event) this.events.push(event);
  }

  async acknowledge(sequence: number): Promise<void> {
    this.validateAck(sequence);
    if (sequence === this.acknowledged) return;
    await this.journal.append({ type: 'ack', sequence });
    this.acknowledged = sequence;
  }

  /**
   * Session state from an earlier epoch describes a generation Switch reconciled during
   * recovery. Replaying it would re-assert that generation's status under the new epoch,
   * so the transcript records the omission instead.
   */
  private currentGeneration(body: HostBody): HostBody {
    if (
      body.type !== 'session.upsert' ||
      body.session.sessionId !== this.session.sessionId ||
      body.session.epoch === this.session.epoch
    )
      return body;
    return {
      type: 'notice',
      level: 'info',
      code: 'PRIOR_GENERATION_STATE_SKIPPED',
      message: `Session state from generation ${body.session.epoch} was not replayed into generation ${this.session.epoch}.`,
    };
  }

  private validateAck(sequence: number): void {
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < this.acknowledged ||
      sequence > this.events.length
    )
      throw new Error('Switch returned an invalid host event receipt.');
  }
}
