import { isDeepEqual } from '../deep-equal';
import type { ServerEvent, Snapshot } from './contract';
import { commandStatusSchema, serverEventSchema, snapshotSchema } from './validation';

/** The server already filters this projection for the viewer. Sequence gaps are valid. */
export class SessionReplica {
  private value: Snapshot;
  readonly notices: Extract<ServerEvent['body'], { type: 'notice' }>[] = [];

  constructor(input: unknown) {
    this.value = snapshotSchema.parse(input);
    if (this.value.nextPageToken !== null)
      throw new Error('Load all snapshot pages before replay.');
  }

  snapshot(): Snapshot {
    return structuredClone(this.value);
  }

  apply(input: unknown): boolean {
    const event = serverEventSchema.parse(input);
    if (event.sessionId !== this.value.session.sessionId)
      throw new Error('Event belongs to another session.');
    if (event.sequence <= this.value.throughSequence) return false;
    const body = event.body;
    switch (body.type) {
      case 'session.upsert':
        if (body.session.sessionId !== event.sessionId)
          throw new Error('Session identity mismatch.');
        if (body.session.epoch !== this.value.session.epoch)
          throw new Error('STALE_EPOCH: reload the snapshot.');
        this.value.session = body.session;
        break;
      case 'session.connectivity':
        this.value.session.connectivity = body.connectivity;
        break;
      case 'turn.upsert':
        this.upsert(this.value.turns, body, (x) => x.turnId);
        break;
      case 'item.upsert': {
        const previous = this.value.items.find((x) => x.itemId === body.item.itemId);
        if (
          previous &&
          previous.revision === body.item.revision &&
          !isDeepEqual(previous, body.item)
        )
          throw new Error('Conflicting item revision.');
        if (!previous || previous.revision < body.item.revision)
          this.upsert(this.value.items, body.item, (x) => x.itemId);
        break;
      }
      case 'request.opened': {
        const previous = this.value.requests.find((x) => x.requestId === body.request.requestId);
        if (!previous || previous.revision < body.request.revision)
          this.upsert(
            this.value.requests,
            { ...body.request, result: null, decidedBy: null },
            (x) => x.requestId
          );
        break;
      }
      case 'request.submitting': {
        const request = this.value.requests.find((x) => x.requestId === body.requestId);
        if (request && request.revision === body.revision && request.state === 'open') {
          request.state = 'submitting';
          request.decidedBy = {
            actorId: body.actorId,
            surface: body.surface,
            commandId: body.commandId,
          };
        }
        break;
      }
      case 'request.settled': {
        const request = this.value.requests.find((x) => x.requestId === body.requestId);
        if (request && request.revision < body.revision) {
          request.state = body.outcome === 'answered' ? 'resolved' : 'closed';
          request.revision = body.revision;
          request.result = body;
          if (body.outcome !== 'answered') request.decidedBy = null;
        }
        break;
      }
      case 'command.status':
        this.upsert(this.value.commandStatuses, body, (x) => x.commandId);
        break;
      case 'command.result':
        break; // Only the server confirms shared command status.
      case 'notice':
        this.notices.push(body);
        break;
    }
    this.value.session.pendingRequestIds = this.value.requests
      .filter((x) => x.state === 'open' || x.state === 'submitting')
      .map((x) => x.requestId);
    this.value.throughSequence = event.sequence;
    return true;
  }

  advanceCursor(sequence: number): void {
    if (!Number.isSafeInteger(sequence) || sequence < this.value.throughSequence)
      throw new Error('Invalid replay cursor.');
    this.value.throughSequence = sequence;
  }

  recordReceipt(input: unknown): void {
    const status = commandStatusSchema.parse(input);
    const current = this.value.commandStatuses.find((x) => x.commandId === status.commandId);
    if (
      current &&
      (current.status === 'applied' ||
        current.status === 'rejected' ||
        (current.status === 'dispatched' && status.status === 'accepted'))
    )
      return;
    this.upsert(this.value.commandStatuses, status, (x) => x.commandId);
  }

  private upsert<T>(values: T[], value: T, key: (value: T) => string): void {
    const index = values.findIndex((x) => key(x) === key(value));
    if (index < 0) values.push(value);
    else values[index] = value;
  }
}
