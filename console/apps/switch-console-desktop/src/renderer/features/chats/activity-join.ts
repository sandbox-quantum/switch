import {
  type ChatActivityItem,
  type ChatApproval,
  TURN_ITEM_ID,
} from '@shared/core/chats/activity';
import { type ChatMessage, isSessionStartingNotice, turnEndNotice } from '@shared/core/chats/chats';
import { isControlAck } from './stop-rows';
import { switchTool } from './tool-presentation';

/**
 * Joining an agent's turns, as Switch's activity feed stores them, to the
 * room messages that started them. Every row of a turn the agent took from
 * the room carries that message's id, so a turn shows under its message;
 * its other steps (tool activity, the agent's own text) and its approval
 * requests show with it.
 */

/** `cancelled`: taken out of the agent's queue before it started. */
export type TurnStatus = 'queued' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled';

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
 * When a turn's first step happened, or null before it has one. Switch stores
 * a step when the host reports it, which can be well after the step. The host
 * stamps a step with its own clock, at its latest revision, so that time can
 * be late too. The earliest of both holds up against either.
 */
function firstStepAt(turn: TurnActivity): number | null {
  if (turn.items.length === 0) return null;
  return Math.min(
    ...turn.items.flatMap((item) => [Date.parse(item.occurredAt), Date.parse(item.createdAt)])
  );
}

/** One of the agent's own messages in the room, not a host notice or a control acknowledgement. */
function isAgentReply(message: ChatMessage, agentId: string): boolean {
  return (
    message.sender.kind === 'agent' &&
    message.sender.agentId === agentId &&
    !isSessionStartingNotice(message) &&
    !turnEndNotice(message) &&
    !isControlAck(message)
  );
}

/**
 * Where a turn's requests show, by the message each shows under: after the
 * agent's messages of that turn sent before the request settled, so the text
 * leading up to a question reads above it. An open request shows after the
 * turn's latest message so far. `anchorId` is where the turn itself shows.
 * Shortcut: Switch keeps no time a request was asked, so a settled one is placed
 * by when it was answered (or expired); store an asked-at time if that misplaces one.
 */
export function placeRequests(
  messages: readonly ChatMessage[],
  agentId: string,
  bound: ReadonlyMap<string, TurnActivity>,
  anchorId: string,
  turn: TurnActivity
): Map<string, ChatApproval[]> {
  const placed = new Map<string, ChatApproval[]>();
  const start = messages.findIndex((each) => each.messageId === anchorId);
  if (start === -1) return placed;
  for (const request of turn.requests) {
    const settledAt = request.answeredAt ?? (request.state === 'open' ? null : request.expiresAt);
    const until = settledAt === null ? Infinity : Date.parse(settledAt);
    let anchor = start;
    for (let next = start + 1; next < messages.length; next++) {
      const each = messages[next];
      // The agent's next turn starts here; what follows is that turn's.
      if (bound.has(each.messageId) && bound.get(each.messageId) !== turn) break;
      if (Date.parse(each.sentAt) > until) break;
      if (isAgentReply(each, agentId)) anchor = next;
    }
    const key = messages[anchor].messageId;
    placed.set(key, [...(placed.get(key) ?? []), request]);
  }
  return placed;
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
  const shown = (each: ChatMessage) => isAgentReply(each, agentId);
  messages.forEach((message, at) => {
    const turn = bound.get(message.messageId);
    if (!turn) return;
    let anchor = at;
    if (previous !== null) {
      const after = previous;
      const reply = messages.findIndex((each, index) => index > after && shown(each));
      anchor = Math.max(at, reply === -1 ? previous : reply);
    }
    const firstStep = firstStepAt(turn);
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
          !((firstStepAt(each) ?? -Infinity) > Date.parse(message.sentAt))
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
  const tool = switchTool(item.title);
  return (
    tool === 'post_message' ||
    tool === 'send_targeted_message' ||
    /^ToolSearch(\s|$)/.test(item.title)
  );
}

/** The tool calls a turn shows. Assistant text is left out: the room message is the copy shown. */
export function turnTools(turn: TurnActivity): ChatActivityItem[] {
  return turn.items.filter(
    (item) => item.kind === 'tool-activity' && !item.subagent && !isHiddenTool(item)
  );
}

export function turnSubagents(turn: TurnActivity): ChatActivityItem[] {
  return turn.items
    .filter((item) => item.kind === 'tool-activity' && item.subagent)
    .sort((a, b) => Number(b.status === 'in-progress') - Number(a.status === 'in-progress'));
}

/**
 * The text Switch gives a subagent it settles because the agent's session went
 * away while it was running. The same words as `ORPHANED_SUBAGENT_TEXT` in
 * switch-core's `sessions/contract.py`.
 */
export const ORPHANED_SUBAGENT_TEXT =
  "Ended by Switch: the agent's session went away before this subagent finished.";

/**
 * How a subagent stands, in the words the chat platforms use too. A subagent can
 * outlive its turn, so one still at work is running whatever the turn says.
 */
export function subagentStatus(item: ChatActivityItem): string {
  if (item.status === 'in-progress') return 'running';
  if (item.status === 'completed') return 'done';
  if (item.status === 'declined') return 'stopped';
  return item.text === ORPHANED_SUBAGENT_TEXT ? 'not confirmed finished' : 'failed';
}

/** Whether the turn is running with no visible tool currently running. */
export function isThinking(turn: TurnActivity): boolean {
  return (
    (turn.status === 'queued' || turn.status === 'running') &&
    !turn.items.some(
      (item) =>
        item.kind === 'tool-activity' &&
        !isHiddenTool(item) &&
        toolState(item, turn.status) === 'running'
    )
  );
}
