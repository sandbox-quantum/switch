import type { HostBody, Item, Origin, Session } from '@switch-console/shared/session-v1';
import type { ProviderRuntimeEvent } from '../events';

type TurnContext = { commandId: string | null; origin: Origin | null };
type BufferedItem = { item: Item; emittedAt: number; dirty: boolean };

/** Projects chat and tool summaries only. The host owns sequencing and durable publication. */
export class ChatProjector {
  private readonly turns = new Map<string, TurnContext>();
  private readonly items = new Map<string, BufferedItem>();
  private readonly hidden = new Set<string>();

  constructor(private readonly session: Session) {}

  bindTurn(turnId: string, context: TurnContext): void {
    if (this.turns.has(turnId)) throw new Error('Turn is already bound.');
    this.turns.set(turnId, structuredClone(context));
  }

  ingest(event: ProviderRuntimeEvent, now: number): HostBody[] {
    if (event.sessionId !== this.session.sessionId || event.provider !== this.session.provider)
      throw new Error('Provider event identity mismatch.');
    switch (event.type) {
      case 'session.state.changed':
        this.session.status = event.status;
        return [{ type: 'session.upsert', session: structuredClone(this.session) }];
      case 'session.exited':
        if (this.session.status !== 'error') this.session.status = 'stopped';
        return [
          ...this.flush(now, true),
          { type: 'session.upsert', session: structuredClone(this.session) },
        ];
      case 'turn.started':
        return [
          {
            type: 'turn.upsert',
            turnId: event.turnId,
            status: 'running',
            commandId: this.context(event.turnId).commandId,
          },
        ];
      case 'turn.completed':
        return [
          ...this.flush(now, true),
          {
            type: 'turn.upsert',
            turnId: event.turnId,
            status: event.outcome,
            commandId: this.context(event.turnId).commandId,
          },
        ];
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const key = JSON.stringify([event.turnId, event.item.id]);
        if (event.item.type === 'reasoning') {
          this.hidden.add(key);
          return [];
        }
        const context = this.context(event.turnId);
        const previous = this.items.get(key);
        const kind =
          event.item.type === 'assistant_message'
            ? 'assistant-message'
            : event.item.type === 'user_message'
              ? 'user-message'
              : 'tool-activity';
        // Raw tool output and vendor payloads are not a shared tool summary.
        const item: Item = {
          itemId: key,
          turnId: event.turnId,
          revision: previous?.item.revision ?? 0,
          kind,
          status: event.item.status === 'in_progress' ? 'in-progress' : event.item.status,
          title: event.item.title,
          text: kind === 'tool-activity' ? '' : (event.item.text ?? previous?.item.text ?? ''),
          attachments: [],
          origin: kind === 'user-message' ? context.origin : null,
        };
        const buffered = { item, emittedAt: previous?.emittedAt ?? -Infinity, dirty: true };
        this.items.set(key, buffered);
        return this.emitItem(buffered, now, event.type === 'item.completed');
      }
      case 'content.delta': {
        const key = JSON.stringify([event.turnId, event.itemId]);
        if (this.hidden.has(key)) return [];
        const buffered = this.items.get(key);
        if (!buffered || buffered.item.kind !== 'assistant-message')
          throw new Error('Text delta has no assistant item.');
        buffered.item.text += event.delta;
        buffered.dirty = true;
        return this.emitItem(buffered, now, false);
      }
      case 'item.delta':
        return []; // Tool output and reasoning stay on the execution host.
      default:
        return [];
    }
  }

  /** Call on a 250ms host tick, and before publishing terminal state. */
  flush(now: number, final: boolean): HostBody[] {
    return [...this.items.values()].flatMap((item) => this.emitItem(item, now, final));
  }

  private emitItem(buffer: BufferedItem, now: number, final: boolean): HostBody[] {
    if (!buffer.dirty || (!final && now - buffer.emittedAt < 250)) return [];
    buffer.item.revision += 1;
    buffer.emittedAt = now;
    buffer.dirty = false;
    return [{ type: 'item.upsert', item: structuredClone(buffer.item) }];
  }

  private context(turnId: string): TurnContext {
    const context = this.turns.get(turnId);
    if (!context) throw new Error('Bind verified command origin before processing the turn.');
    return context;
  }
}
