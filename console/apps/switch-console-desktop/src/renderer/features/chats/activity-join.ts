import type { HostBody, Item, Snapshot } from '@switch-console/shared/session-v1';
import type { ToolState } from './ui/tool';

/**
 * Joining an agent's session activity to the room messages that started it.
 *
 * A room message the agent was addressed with runs as one turn whose command
 * id is `roomCommandId(agent, room, message)`, and whose user-message item
 * carries the message id in its origin. Either identifies the turn; the
 * turn's other items (tool activity, the agent's own text) and its approval
 * requests are then shown under that message. Nothing is joined across
 * sessions or epochs: bindings are made per activity key and dropped when it
 * changes.
 */

export type TurnStatus = Extract<HostBody, { type: 'turn.upsert' }>['status'];

export type TurnActivity = {
  turnId: string;
  status: TurnStatus;
  /** Tool activity and assistant text, in the order the host recorded them. */
  items: Item[];
  requests: Snapshot['requests'];
};

/**
 * The turns of a snapshot by the room message that started them.
 * `commandIds` maps a room message id to its derived command id.
 */
export function bindTurns(
  snapshot: Snapshot,
  roomId: string,
  commandIds: ReadonlyMap<string, string>
): Map<string, TurnActivity> {
  const byCommand = new Map<string, string>();
  for (const [messageId, commandId] of commandIds) byCommand.set(commandId, messageId);
  const origins = new Map<string, string>();
  const items = new Map<string, Item[]>();
  for (const item of snapshot.items) {
    if (item.kind === 'user-message') {
      if (item.origin?.roomId === roomId && item.origin.messageId)
        origins.set(item.turnId, item.origin.messageId);
      continue;
    }
    const list = items.get(item.turnId) ?? [];
    list.push(item);
    items.set(item.turnId, list);
  }
  const bound = new Map<string, TurnActivity>();
  for (const turn of snapshot.turns) {
    const messageId =
      origins.get(turn.turnId) ??
      (turn.commandId !== null ? byCommand.get(turn.commandId) : undefined) ??
      byCommand.get(turn.turnId);
    if (!messageId || !commandIds.has(messageId)) continue;
    bound.set(messageId, {
      turnId: turn.turnId,
      status: turn.status,
      items: items.get(turn.turnId) ?? [],
      requests: snapshot.requests.filter((request) => request.turnId === turn.turnId),
    });
  }
  return bound;
}

/** The card state of a tool item, given its turn's status. */
export function toolState(item: Item, turn: TurnStatus): ToolState {
  if (item.status === 'completed') return 'done';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'declined') return 'declined';
  return turn === 'interrupted' || turn === 'error' ? 'failed' : 'running';
}

/**
 * The tool cards a turn shows. Assistant text is left out: what the agent
 * means the room to read it posts there, and the room message is the copy
 * shown.
 */
export function turnTools(turn: TurnActivity): Item[] {
  return turn.items.filter((item) => item.kind === 'tool-activity');
}

/** Whether the turn is under way with no tool run yet. */
export function isThinking(turn: TurnActivity): boolean {
  return (
    (turn.status === 'queued' || turn.status === 'running') &&
    !turn.items.some((item) => item.kind === 'tool-activity')
  );
}

/**
 * Keeps the bindings made under one activity key, and drops them all when the
 * key changes — another session, a new epoch, another controller run — so a
 * turn from an earlier run is never shown under a message of a later one.
 */
export class ActivityBindings {
  private key: string | null = null;
  private bound = new Map<string, TurnActivity>();

  update(key: string, next: Map<string, TurnActivity>): Map<string, TurnActivity> {
    if (key !== this.key) {
      this.key = key;
      this.bound = new Map();
    }
    for (const [messageId, turn] of next) this.bound.set(messageId, turn);
    return this.bound;
  }

  clear(): void {
    this.key = null;
    this.bound = new Map();
  }
}
