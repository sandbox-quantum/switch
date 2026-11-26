import type {
  HostBody,
  Item,
  Origin,
  Session,
  ToolCall,
  ToolDetail,
} from '@switch-console/shared/session-v1';
import type { ProviderItem, ProviderRuntimeEvent } from '../events';
import type { Redactions } from '../host/redaction';
import { payloadInput } from '../host/tool-detail-buffer';

type TurnContext = { commandId: string | null; origin: Origin | null };

/** As much text as one published item carries; longer text goes in `:part:` items after it. */
export const ITEM_PART_CHARACTERS = 4096;
/**
 * The most a tool's detail takes of one published event, which is capped at
 * 64 KiB with the item's title and text around it. Longer strings are cut
 * until it fits, and the detail says it was.
 */
export const TOOL_DETAIL_BYTES = 24 * 1024;

/**
 * `item` with `text`, as the items it is published as: the first under the
 * item's own id, and each further {@link ITEM_PART_CHARACTERS} of text under
 * `<id>:part:<n>`. At least `minimum` of them, so an item whose text has grown
 * shorter still updates every part it was published in before.
 */
export function itemParts(item: Item, text: string, minimum: number): Item[] {
  const characters = Array.from(text);
  const count = Math.max(1, Math.ceil(characters.length / ITEM_PART_CHARACTERS), minimum);
  return Array.from({ length: count }, (_, index) => {
    const part: Item = {
      ...structuredClone(item),
      itemId: index === 0 ? item.itemId : `${item.itemId}:part:${index}`,
      text: characters
        .slice(index * ITEM_PART_CHARACTERS, (index + 1) * ITEM_PART_CHARACTERS)
        .join(''),
    };
    // The detail is the item's, carried once, by its first part.
    if (index > 0) delete part.detail;
    return part;
  });
}

const ENDED_ITEM = new Set(['completed', 'failed', 'declined']);
const DIFF_START = /^(diff --git |--- |@@ )/;

/**
 * What a tool step called and, once it ended, what came back: the provider's
 * structured payload as the tool's input (the tool_use input for Claude Code;
 * the vendor's item for others), its tool name, and its output text. A file
 * change whose output reads as a unified diff gives it as `diff`. Undefined
 * when the provider says nothing of the call.
 */
export function toolDetail(
  item: ProviderItem,
  previous: ToolDetail | undefined
): ToolDetail | undefined {
  const given = item.payload ? payloadInput(item.payload) : undefined;
  const input =
    given === undefined || given === null
      ? previous?.tool.input
      : typeof given === 'object' && !Array.isArray(given)
        ? (given as Record<string, unknown>)
        : { value: given };
  const name = item.toolName ?? previous?.tool.name ?? (input ? item.type : undefined);
  if (!name || !input) return undefined;
  const detail: ToolDetail = { tool: { name, input }, truncated: false };
  if (ENDED_ITEM.has(item.status)) {
    const result: NonNullable<ToolDetail['result']> = { isError: item.status === 'failed' };
    const text = item.text;
    if (text !== undefined && text !== '') {
      if (item.type === 'file_change' && DIFF_START.test(text)) result.diff = text;
      else result.text = text;
    }
    const files = ['file_path', 'notebook_path', 'path']
      .map((key) => input[key])
      .filter((value): value is string => typeof value === 'string' && value !== '');
    if (files.length > 0) result.files = [...new Set(files)];
    detail.result = result;
  }
  return fitDetail(detail, TOOL_DETAIL_BYTES);
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function cutStrings(value: unknown, limit: number): unknown {
  if (typeof value === 'string') {
    const characters = Array.from(value);
    return characters.length <= limit ? value : `${characters.slice(0, limit).join('')}…`;
  }
  if (Array.isArray(value)) return value.map((each) => cutStrings(each, limit));
  if (value !== null && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, each]) => [key, cutStrings(each, limit)])
    );
  return value;
}

/** `tool`, cut as {@link fitDetail} cuts a detail's call. */
export function fitToolCall(tool: ToolCall, budget: number): ToolCall {
  return fitDetail({ tool, truncated: false }, budget).tool;
}

/** `detail`, its strings cut shorter and shorter until it fits in `budget` bytes. */
export function fitDetail(detail: ToolDetail, budget: number): ToolDetail {
  if (byteLength(detail) <= budget) return detail;
  for (let limit = 8192; limit >= 64; limit = Math.floor(limit / 2)) {
    const cut: ToolDetail = {
      tool: {
        name: detail.tool.name,
        input: cutStrings(detail.tool.input, limit) as Record<string, unknown>,
      },
      ...(detail.result
        ? { result: cutStrings(detail.result, limit) as NonNullable<ToolDetail['result']> }
        : {}),
      truncated: true,
    };
    if (byteLength(cut) <= budget) return cut;
  }
  // Too many fields to fit even cut short: the call's name and outcome only.
  return {
    tool: { name: detail.tool.name.slice(0, 200), input: {} },
    ...(detail.result ? { result: { isError: detail.result.isError } } : {}),
    truncated: true,
  };
}
type BufferedItem = { item: Item; emittedAt: number; dirty: boolean; parts: number };

/** Projects chat and tool summaries only. The host owns sequencing and durable publication. */
export class ChatProjector {
  private readonly turns = new Map<string, TurnContext>();
  private readonly items = new Map<string, BufferedItem>();
  private readonly hidden = new Set<string>();
  private readonly childEvents = new Map<string, number>();

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

  restore(items: Item[]): void {
    for (const item of items) {
      if (item.kind !== 'tool-activity' || !item.subagent) continue;
      this.items.set(item.itemId, {
        item: structuredClone(item),
        emittedAt: -Infinity,
        dirty: false,
        parts: 1,
      });
    }
  }

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
        const child = event.item.type === 'subagent';
        const key =
          child && event.item.nativeChildId
            ? JSON.stringify([event.turnId, 'subagent', event.item.nativeChildId])
            : JSON.stringify([event.turnId, event.item.id]);
        if (event.item.type === 'reasoning') {
          this.hidden.add(key);
          return [];
        }
        const context = this.context(event.turnId);
        const previous = this.items.get(key);
        if (child) {
          const at = Date.parse(event.createdAt);
          const prior = this.childEvents.get(key);
          if (prior !== undefined && at < prior) return [];
          // A repeated start cannot reopen a child that already finished.
          if (
            previous &&
            previous.item.status !== 'in-progress' &&
            event.item.status === 'in_progress'
          )
            return [];
          this.childEvents.set(key, at);
        }
        const kind =
          event.item.type === 'assistant_message'
            ? 'assistant-message'
            : event.item.type === 'user_message'
              ? 'user-message'
              : 'tool-activity';
        // Raw tool output and vendor payloads stay out of the summary; a tool
        // step carries them, bounded, in its own `detail`.
        const item: Item = {
          itemId: key,
          turnId: event.turnId,
          revision: previous?.item.revision ?? 0,
          kind,
          ...(child ? { subagent: true } : {}),
          status: event.item.status === 'in_progress' ? 'in-progress' : event.item.status,
          title: this.visible(
            child && event.item.toolName && event.item.toolName !== event.item.title
              ? `${event.item.toolName}: ${event.item.title}`
              : child && !event.item.title
                ? (previous?.item.title ?? 'Subagent')
                : event.item.title,
            true
          ).slice(0, ITEM_PART_CHARACTERS),
          text: kind === 'tool-activity' ? '' : (event.item.text ?? previous?.item.text ?? ''),
          attachments: [],
          origin: kind === 'user-message' ? context.origin : null,
        };
        if (kind === 'tool-activity' && !child) {
          const detail = toolDetail(event.item, previous?.item.detail);
          if (detail) item.detail = detail;
        }
        if (
          child &&
          previous &&
          previous.item.status === item.status &&
          previous.item.title === item.title
        )
          return [];
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
