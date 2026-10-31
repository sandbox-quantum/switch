import {
  type ChatActivityItem,
  type ChatApproval,
  TURN_ITEM_ID,
} from '@shared/core/chats/activity';
import { type ChatMessage, isSessionStartingNotice, turnEndNotice } from '@shared/core/chats/chats';
import { isControlAck } from './stop-rows';

/**
 * Joining an agent's turns, as Switch's activity feed stores them, to the
 * room messages that started them. Every row of a turn the agent took from
 * the room carries that message's id, so a turn shows under its message;
 * its other steps (tool activity, the agent's own text) and its approval
 * requests show with it.
 */

export type TurnStatus = 'queued' | 'running' | 'completed' | 'interrupted' | 'error';

export type TurnActivity = {
  sessionId: string;
  turnId: string;
  status: TurnStatus;
  roomId: string | null;
  messageId: string | null;
  /** Tool activity and assistant text, in the order the host recorded them. */
  items: ChatActivityItem[];
  requests: ChatApproval[];
};

/** Where a row is held: one per step, whatever its revision. */
export const itemKey = (item: ChatActivityItem): string =>
  JSON.stringify([item.sessionId, item.turnId, item.itemId]);
export const turnKey = (sessionId: string, turnId: string): string =>
  JSON.stringify([sessionId, turnId]);

/** One agent's rows grouped into turns, oldest first. A turn not reported yet is left out. */
export function groupTurns(
  items: Iterable<ChatActivityItem>,
  approvals: Iterable<ChatApproval>
): TurnActivity[] {
  const byCreation = (a: ChatActivityItem, b: ChatActivityItem) =>
    a.createdAt.localeCompare(b.createdAt) || a.itemId.localeCompare(b.itemId);
  const rows = [...items].sort(byCreation);
  const turns = new Map<string, TurnActivity>();
  for (const row of rows)
    if (row.itemId === TURN_ITEM_ID)
      turns.set(turnKey(row.sessionId, row.turnId), {
        sessionId: row.sessionId,
        turnId: row.turnId,
        status: row.status as TurnStatus,
        roomId: row.roomId,
        messageId: row.messageId,
        items: [],
        requests: [],
      });
  for (const row of rows)
    if (row.itemId !== TURN_ITEM_ID) turns.get(turnKey(row.sessionId, row.turnId))?.items.push(row);
  for (const approval of approvals)
    turns.get(turnKey(approval.sessionId, approval.turnId))?.requests.push(approval);
  return [...turns.values()];
}

/** The turns started by a message of `roomId`, by that message; a later turn for it wins. */
export function bindTurns(
  turns: readonly TurnActivity[],
  roomId: string
): Map<string, TurnActivity> {
  const bound = new Map<string, TurnActivity>();
  for (const turn of turns)
    if (turn.roomId === roomId && turn.messageId) bound.set(turn.messageId, turn);
  return bound;
}

/**
 * The turns a host notice in the room says ended, though the activity feed
 * still has them going: the feed lost the turn's last update (the machine was
 * reconnecting), and nothing would otherwise ever end it. Each failed or
 * stopped notice from the agent ends its latest turn still going that started
 * at a message before it.
 */
export function settleTurnsByNotices(
  turns: readonly TurnActivity[],
  messages: readonly ChatMessage[],
  agentId: string,
  roomId: string
): TurnActivity[] {
  const going = (turn: TurnActivity) => turn.status === 'running' || turn.status === 'queued';
  if (!turns.some(going)) return [...turns];
  const bound = bindTurns(turns, roomId);
  const settled = new Map<TurnActivity, TurnStatus>();
  messages.forEach((message, at) => {
    const notice = message.sender.agentId === agentId ? turnEndNotice(message) : null;
    if (!notice || notice.outcome === 'completed') return;
    const turn = messages
      .slice(0, at)
      .map((each) => bound.get(each.messageId))
      .findLast((each) => each !== undefined && going(each) && !settled.has(each));
    if (turn) settled.set(turn, notice.outcome === 'failed' ? 'error' : 'interrupted');
  });
  if (settled.size === 0) return [...turns];
  return turns.map((turn) => {
    const status = settled.get(turn);
    return status ? { ...turn, status } : turn;
  });
}

/**
 * Where one agent's turns show, by the message each shows under, in message
 * order. A turn shows under the message that started it, unless that message
 * was sent while the agent's previous turn still ran: the turn then runs after
 * that turn's reply, and shows under it. Shortcut: the reply is taken to be
 * the agent's first message after the previous turn, so a turn that ended
 * without a reply pushes the next turn under its own reply. A turn also shows
 * after the agent's own messages sent before its first step, such as an
 * acknowledgement posted while the session started.
 */
export function placeTurns(
  messages: readonly ChatMessage[],
  agentId: string,
  bound: ReadonlyMap<string, TurnActivity>
): Map<string, TurnActivity[]> {
  const placed = new Map<string, TurnActivity[]>();
  let previous: number | null = null;
  const shown = (each: ChatMessage) =>
    each.sender.kind === 'agent' &&
    each.sender.agentId === agentId &&
    !isSessionStartingNotice(each) &&
    !turnEndNotice(each) &&
    !isControlAck(each);
  messages.forEach((message, at) => {
    const turn = bound.get(message.messageId);
    if (!turn) return;
    let anchor = at;
    if (previous !== null) {
      const after = previous;
      const reply = messages.findIndex((each, index) => index > after && shown(each));
      anchor = Math.max(at, reply === -1 ? previous : reply);
    }
    const firstStep = turn.items[0] ? Date.parse(turn.items[0].createdAt) : null;
    for (let next = anchor + 1; firstStep !== null && next < messages.length; next++) {
      const each = messages[next];
      if (bound.has(each.messageId) || Date.parse(each.sentAt) >= firstStep) break;
      if (shown(each)) anchor = next;
    }
    const key = messages[anchor].messageId;
    placed.set(key, [...(placed.get(key) ?? []), turn]);
    previous = turn.status === 'interrupted' || turn.status === 'error' ? null : anchor;
  });
  return placed;
}

/**
 * The host's notices of turns that ended without a reply, each matched to the
 * turn it reports: the agent's latest turn before it that shows the same
 * ending and has no notice yet. A queued turn may have started in between.
 * Only the session's own turns are bound, which keeps the search to it. Maps
 * the notice's message id to the turn id.
 */
export function foldTurnEndNotices(
  messages: readonly ChatMessage[],
  agentId: string,
  bound: ReadonlyMap<string, TurnActivity>
): Map<string, string> {
  const folded = new Map<string, string>();
  const claimed = new Set<string>();
  messages.forEach((message, at) => {
    const notice = message.sender.agentId === agentId ? turnEndNotice(message) : null;
    if (!notice) return;
    const status = { failed: 'error', interrupted: 'interrupted', completed: null }[notice.outcome];
    const turn = messages
      .slice(0, at)
      .map((each) => bound.get(each.messageId))
      .findLast(
        (each) =>
          each?.status === status &&
          !claimed.has(each.turnId) &&
          // A notice from before the turn started is about an earlier run of its
          // message (the one a retry ran again), not this one.
          !(each.items[0] && Date.parse(each.items[0].createdAt) > Date.parse(message.sentAt))
      );
    if (!turn) return;
    claimed.add(turn.turnId);
    folded.set(message.messageId, turn.turnId);
  });
  return folded;
}

export type ToolState = 'running' | 'done' | 'failed' | 'declined';

/** How a tool item stands, given its turn's status: one left open by a turn that ended failed. */
export function toolState(item: Pick<ChatActivityItem, 'status'>, turn: TurnStatus): ToolState {
  if (item.status === 'completed') return 'done';
  if (item.status === 'failed') return 'failed';
  if (item.status === 'declined') return 'declined';
  return turn === 'interrupted' || turn === 'error' ? 'failed' : 'running';
}

/** Tool calls whose only output is the room message the user already sees. */
export function isHiddenTool(item: Pick<ChatActivityItem, 'title'>): boolean {
  return (
    /^mcp__switch__post_message(\s|$)/.test(item.title) ||
    /^mcp__switch__send_targeted_message(\s|$)/.test(item.title) ||
    /^ToolSearch(\s|$)/.test(item.title)
  );
}

/** Whether a row is work the agent did: a tool call, or a subagent it started. */
function isWork(item: Pick<ChatActivityItem, 'kind'>): boolean {
  return item.kind === 'tool-activity' || item.kind === 'subagent';
}

/** The tool calls and subagents a turn shows. Assistant text is left out: the room message is the copy shown. */
export function turnTools(turn: TurnActivity): ChatActivityItem[] {
  return turn.items.filter((item) => isWork(item) && !isHiddenTool(item));
}

/** Whether the turn is running with no visible tool currently running. */
export function isThinking(turn: TurnActivity): boolean {
  return (
    (turn.status === 'queued' || turn.status === 'running') &&
    !turn.items.some(
      (item) => isWork(item) && !isHiddenTool(item) && toolState(item, turn.status) === 'running'
    )
  );
}
