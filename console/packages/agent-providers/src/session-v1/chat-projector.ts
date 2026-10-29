import type { HostBody, Item, Origin, Session } from '@switch-console/shared/session-v1';
import type { ProviderRuntimeEvent } from '../events';
import type { Redactions } from '../host/redaction';

type TurnContext = { commandId: string | null; origin: Origin | null };

/** As much text as one published item carries; longer text goes in `:part:` items after it. */
export const ITEM_PART_CHARACTERS = 4096;

/**
 * `item` with `text`, as the items it is published as: the first under the
 * item's own id, and each further {@link ITEM_PART_CHARACTERS} of text under
 * `<id>:part:<n>`. At least `minimum` of them, so an item whose text has grown
 * shorter still updates every part it was published in before.
 */
export function itemParts(item: Item, text: string, minimum: number): Item[] {
  const characters = Array.from(text);
  const count = Math.max(1, Math.ceil(characters.length / ITEM_PART_CHARACTERS), minimum);
  return Array.from({ length: count }, (_, index) => ({
    ...structuredClone(item),
    itemId: index === 0 ? item.itemId : `${item.itemId}:part:${index}`,
    text: characters
      .slice(index * ITEM_PART_CHARACTERS, (index + 1) * ITEM_PART_CHARACTERS)
      .join(''),
  }));
}
type BufferedItem = { item: Item; emittedAt: number; dirty: boolean; parts: number };

/** Projects chat and tool summaries only. The host owns sequencing and durable publication. */
export class ChatProjector {
  private readonly turns = new Map<string, TurnContext>();
  private readonly items = new Map<string, BufferedItem>();
  private readonly hidden = new Set<string>();

  /**
   * `redactions`, the service tokens the session was handed, are scrubbed
   * from an assistant message's whole text before it is split into parts,
   * and text still streaming in holds back what could be the start of one,
   * so no published revision or part carries a token in pieces.
   */
  constructor(
    private readonly session: Session,
    private readonly redactions: Redactions | null
  ) {}

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
          title: event.item.title.slice(0, ITEM_PART_CHARACTERS),
          text: kind === 'tool-activity' ? '' : (event.item.text ?? previous?.item.text ?? ''),
          attachments: [],
          origin: kind === 'user-message' ? context.origin : null,
        };
        const buffered = {
          item,
          emittedAt: previous?.emittedAt ?? -Infinity,
          dirty: true,
          parts: previous?.parts ?? 1,
        };
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
    const parts = itemParts(buffer.item, this.visible(buffer.item.text, final), buffer.parts);
    buffer.parts = parts.length;
    return parts.map((item) => ({ type: 'item.upsert' as const, item }));
  }

  private visible(text: string, final: boolean): string {
    if (!this.redactions) return text;
    const held = final ? 0 : this.redactions.unfinished(text);
    return this.redactions.text(text.slice(0, text.length - held));
  }

  private context(turnId: string): TurnContext {
    const context = this.turns.get(turnId);
    if (!context) throw new Error('Bind verified command origin before processing the turn.');
    return context;
  }
}
