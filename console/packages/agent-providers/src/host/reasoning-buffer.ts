import { z } from 'zod';
import type { ProviderRuntimeEvent } from '../events';
import { hostToolTurnSchema } from './tool-detail-buffer';

/**
 * The model's reasoning for recent turns, held in memory by the session host
 * and nowhere else.
 *
 * Reasoning is a local side channel: it is never recorded as a session-v1
 * event, never journaled, never in a snapshot or a replay, and never sent to
 * Switch. A Console on the same machine (or over SSH) asks for it with a
 * `reasoning` request and gets what is still buffered; a host restart, a
 * reset (a new epoch) or age drops it.
 *
 * Timing is only what the provider said: `startedAt` comes from a real start
 * signal (the reasoning item starting in progress, or its first delta), and
 * `completedAt` from the item completing. A provider that only reports
 * reasoning once it is done (Claude) leaves `startedAt` null rather than
 * having one made up from the completion.
 */

/** How many turns are kept; the oldest go first. */
export const REASONING_TURN_LIMIT = 50;
/** How much reasoning text one turn keeps, in UTF-16 code units; the latest is kept. */
export const REASONING_TEXT_LIMIT = 32 * 1024;
/** How many reasoning items one turn keeps; the oldest go first. */
const REASONING_ITEM_LIMIT = 256;

export const hostReasoningTurnSchema = z.object({
  turnId: z.string().min(1),
  text: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
});
export type HostReasoningTurn = z.infer<typeof hostReasoningTurnSchema>;

export const hostReasoningListSchema = z.object({
  epoch: z.string().min(1),
  turns: z.array(hostReasoningTurnSchema),
  /**
   * What the turns' tool calls were given and gave back, from the
   * `ToolDetailBuffer`. Rides on the reasoning answer so it reaches Console by
   * the same local-or-SSH path; a host that predates it leaves it out.
   */
  tools: z.array(hostToolTurnSchema).optional(),
});
export type HostReasoningList = z.infer<typeof hostReasoningListSchema>;

type ReasoningItem = { text: string; startedAt: number | null; completedAt: number | null };
type ReasoningTurnEntry = { items: Map<string, ReasoningItem> };

function tail(text: string): string {
  return text.length > REASONING_TEXT_LIMIT ? text.slice(text.length - REASONING_TEXT_LIMIT) : text;
}

export class ReasoningBuffer {
  private epoch: string | null = null;
  /** In insertion order, so the first entry is the oldest turn. */
  private readonly turns = new Map<string, ReasoningTurnEntry>();

  /** Take one provider event, for the session's current epoch. Ignores all but reasoning. */
  ingest(event: ProviderRuntimeEvent, epoch: string, now: number): void {
    if (this.epoch !== epoch) {
      this.turns.clear();
      this.epoch = epoch;
    }
    switch (event.type) {
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        if (event.item.type !== 'reasoning') return;
        const item = this.item(event.turnId, event.item.id, true)!;
        if (event.item.text !== undefined && event.item.text.length > 0)
          item.text = tail(event.item.text);
        // An item that first appears already finished carries no start signal.
        if (item.startedAt === null && event.type !== 'item.completed') {
          if (event.item.status === 'in_progress') item.startedAt = now;
        }
        if (event.type === 'item.completed' || event.item.status !== 'in_progress')
          item.completedAt ??= now;
        this.trim(event.turnId);
        return;
      }
      case 'item.delta':
      case 'content.delta': {
        const item = this.item(event.turnId, event.itemId, false);
        if (!item || event.delta.length === 0) return;
        item.text = tail(item.text + event.delta);
        item.startedAt ??= now;
        this.trim(event.turnId);
        return;
      }
      default:
        return;
    }
  }

  /** What is buffered for `turnIds` (every turn when null), oldest first. */
  list(epoch: string, turnIds: string[] | null): HostReasoningList {
    if (this.epoch !== epoch) return { epoch, turns: [] };
    const wanted = turnIds === null ? null : new Set(turnIds);
    const turns: HostReasoningTurn[] = [];
    for (const [turnId, entry] of this.turns) {
      if (wanted && !wanted.has(turnId)) continue;
      const items = [...entry.items.values()];
      const starts = items.flatMap((item) => (item.startedAt === null ? [] : [item.startedAt]));
      const open = items.some((item) => item.completedAt === null);
      const completions = items.flatMap((item) =>
        item.completedAt === null ? [] : [item.completedAt]
      );
      turns.push({
        turnId,
        text: tail(
          items
            .map((item) => item.text)
            .filter((text) => text.length > 0)
            .join('\n\n')
        ),
        startedAt: starts.length > 0 ? new Date(Math.min(...starts)).toISOString() : null,
        completedAt:
          !open && completions.length > 0 ? new Date(Math.max(...completions)).toISOString() : null,
      });
    }
    return { epoch, turns };
  }

  /** Keep a turn within its text and item limits by dropping its oldest reasoning first. */
  private trim(turnId: string): void {
    const entry = this.turns.get(turnId);
    if (!entry) return;
    while (entry.items.size > REASONING_ITEM_LIMIT) {
      const oldest = entry.items.keys().next().value;
      if (oldest === undefined) break;
      entry.items.delete(oldest);
    }
    let excess = -REASONING_TEXT_LIMIT;
    for (const item of entry.items.values()) excess += item.text.length;
    for (const item of entry.items.values()) {
      if (excess <= 0) break;
      const cut = Math.min(excess, item.text.length);
      item.text = item.text.slice(cut);
      excess -= cut;
    }
  }

  private item(turnId: string, itemId: string, create: boolean): ReasoningItem | null {
    let entry = this.turns.get(turnId);
    if (!entry) {
      if (!create) return null;
      entry = { items: new Map() };
      this.turns.set(turnId, entry);
      while (this.turns.size > REASONING_TURN_LIMIT) {
        const oldest = this.turns.keys().next().value;
        if (oldest === undefined) break;
        this.turns.delete(oldest);
      }
    }
    let item = entry.items.get(itemId);
    if (!item && create) {
      item = { text: '', startedAt: null, completedAt: null };
      entry.items.set(itemId, item);
    }
    return item ?? null;
  }
}
