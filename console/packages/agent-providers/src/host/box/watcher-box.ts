/**
 * Box mode only: what the agent's room tools and its watcher control do in a
 * box beyond Console's own hosts. Posts made safe to send again and held while
 * Switch is away, the restart line keyed by its turn, the lines for a full
 * box or a kept message, and the launcher's one-time hub tickets. Loaded only
 * through a dynamic import behind `options.box`; `watcher-tools` takes it as
 * an optional dependency and keeps Console's behaviour without it.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  type CallerContext,
  callOperation,
  callOperationOutcome,
  SESSION_SELECTOR_HEADERS,
  type SwitchIdentity,
  type SwitchToolCatalog,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime/hosted';
import { z } from 'zod';
import type { SessionPlacements } from '../placements';
import type { Caller, HostAsk } from '../session-channel';
import { resultText, type RestartNotice, type WatcherBox } from '../watcher-tools';
import {
  HELD_REPLY_LOST_LINE,
  HELD_REPLY_NOTICE,
  HELD_TOOLS,
  type HeldReplies,
  type ResendOutcome,
} from './held-replies';
import { macEquals, takenMac, ticketMac } from './push-key';

const contextEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  sender_name: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  timestamp: z.number(),
});
const roomContextSchema = z.object({
  threads: z.array(z.object({ root: contextEntrySchema, replies: z.array(contextEntrySchema) })),
});
const agentNamesSchema = z.object({
  name: z.string(),
  display_name: z.string().nullable().optional(),
});

/** How far back a `once` reply looks: well past the few messages since a restart. */
const ONCE_CONTEXT_LIMIT = 200;

/**
 * Whether the room already shows `body` from this agent, in the reply's thread
 * (top level when it has none), at or after the message it answers. Reads only
 * the session's own room, as the session. Raises when either read fails.
 */
export async function alreadyInRoom(
  catalog: SwitchToolCatalog,
  ctx: CallerContext,
  agentId: string,
  ask: Extract<HostAsk, { type: 'room-reply' }>,
  body: string
): Promise<boolean> {
  const read = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    const result = await catalog.call(ctx, name, args);
    if (result.isError) throw new Error(`Could not check the room first: ${resultText(result)}`);
    return JSON.parse(resultText(result));
  };
  const self = agentNamesSchema.parse(await read('get_agent_detail', { agent_id: agentId }));
  const names = new Set([self.name, ...(self.display_name ? [self.display_name] : [])]);
  const { threads } = roomContextSchema.parse(
    await read('read_context', { limit: ONCE_CONTEXT_LIMIT })
  );
  const all = threads.flatMap((thread) => [thread.root, ...thread.replies]);
  const after = ask.once?.afterMessageId;
  const since = all.find((entry) => entry.id === after)?.timestamp ?? Number.NEGATIVE_INFINITY;
  const placed = ask.threadId
    ? threads
        .filter(
          (thread) =>
            thread.root.id === ask.threadId || thread.replies.some((r) => r.id === ask.threadId)
        )
        .flatMap((thread) => [thread.root, ...thread.replies])
    : threads.map((thread) => thread.root);
  return placed.some(
    (entry) =>
      entry.kind === 'message' &&
      entry.timestamp >= since &&
      entry.id !== after &&
      names.has(entry.sender_name ?? '') &&
      // Switch Trust may append a note to a post, so the line need only be in it.
      (entry.body ?? '').includes(body)
  );
}

/**
 * A room post by the agent, under a key of its own from the first try, so
 * Switch posts it once however often it is sent. One that fails
 * because Switch is away is held and sent again under the same key when
 * Switch is back, and the agent is told so, rather than told it failed: a
 * failed post read as the turn's end left the room with no reply.
 */
export async function heldPost(
  deps: { placements: SessionPlacements; context: (caller: Caller) => Promise<CallerContext> },
  caller: Caller,
  name: string,
  args: Record<string, unknown>,
  holder: HeldReplies
): Promise<ToolResult> {
  const heldNotice: ToolResult = { content: [{ type: 'text', text: HELD_REPLY_NOTICE }] };
  // Sent again by an agent told it was held: still the one post.
  if (holder.heldLike(caller.sessionId, name, args)) return heldNotice;
  const roomId = deps.placements.roomOf(caller.sessionId);
  const key = `reply:${randomUUID()}`;
  const send = async (as: string, tool: string, sent: Record<string, unknown>) =>
    callOperationOutcome({ ...(await deps.context(caller)), clientTxnId: as }, tool, sent);
  const first = await send(key, name, args);
  if (!first.result.isError || !first.unavailable || roomId === null) return first.result;
  /** One more try, only while the session still attends the room it posted to. */
  const again = async (
    as: string,
    tool: string,
    sent: Record<string, unknown>
  ): Promise<ResendOutcome> => {
    const attended = deps.placements.roomOf(caller.sessionId);
    if (attended !== roomId)
      return {
        kind: 'final',
        detail: `session ${caller.sessionId} no longer attends room ${roomId}${attended ? ` (it attends ${attended})` : ''}`,
      };
    const { result, unavailable } = await send(as, tool, sent);
    if (!result.isError) return { kind: 'posted' };
    // Only the status goes in the log: Switch's own words can quote the post.
    const status = /^(\d{3}): /.exec(resultText(result))?.[1];
    const detail = status ? `Switch answered ${status}` : 'Switch could not be reached';
    return unavailable ? { kind: 'unavailable', detail } : { kind: 'final', detail };
  };
  const thread = typeof args.thread_id === 'string' ? { thread_id: args.thread_id } : {};
  const held = holder.hold({
    key,
    sessionId: caller.sessionId,
    roomId,
    threadId: typeof args.thread_id === 'string' ? args.thread_id : null,
    tool: name,
    args,
    resend: () => again(key, name, args),
    // In the lost post's thread, under a key of its own, so it too is said once.
    tellLost: () => again(`${key}:lost`, 'post_message', { body: HELD_REPLY_LOST_LINE, ...thread }),
  });
  if (!held) return first.result;
  return heldNotice;
}

/**
 * Tells a room, as the session, that a reply it held before this process
 * started was lost, in that reply's thread, under `<key>:lost`, so it
 * is said once however often it is tried. `final` when the session no longer
 * attends that room, or Switch refuses.
 */
export async function tellRoomReplyLost(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  line: { key: string; roomId: string; threadId: string | null };
  attending: string | null;
}): Promise<ResendOutcome> {
  if (input.attending !== input.line.roomId)
    return {
      kind: 'final',
      detail: `session ${input.session.sessionId} no longer attends room ${input.line.roomId}`,
    };
  const { result, unavailable } = await callOperationOutcome(
    {
      identity: input.identity,
      connectionId: input.connectionId,
      selector: {
        [SESSION_SELECTOR_HEADERS.sessionId]: input.session.sessionId,
        [SESSION_SELECTOR_HEADERS.hostId]: input.session.hostId,
        [SESSION_SELECTOR_HEADERS.epoch]: input.session.epoch,
      },
      room: null,
      mediaDir: join(input.root, 'media'),
      cwd: input.cwd,
      deadConnection: (operation) =>
        `Switch refused ${operation}: this agent's connection (${input.connectionId}) had lapsed.`,
      clientTxnId: `${input.line.key}:lost`,
    },
    'post_message',
    {
      body: HELD_REPLY_LOST_LINE,
      ...(input.line.threadId ? { thread_id: input.line.threadId } : {}),
    }
  );
  if (!result.isError) return { kind: 'posted' };
  const status = /^(\d{3}): /.exec(resultText(result))?.[1];
  const detail = status ? `Switch answered ${status}` : 'Switch could not be reached';
  return unavailable ? { kind: 'unavailable', detail } : { kind: 'final', detail };
}

/** Tells the room a new session was refused because the machine is out of memory. */
export async function announceBoxFull(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  threadId: string | null;
  body: string;
}): Promise<void> {
  const ctx: CallerContext = {
    identity: input.identity,
    connectionId: input.connectionId,
    selector: {
      [SESSION_SELECTOR_HEADERS.sessionId]: input.session.sessionId,
      [SESSION_SELECTOR_HEADERS.hostId]: input.session.hostId,
      [SESSION_SELECTOR_HEADERS.epoch]: input.session.epoch,
    },
    room: null,
    mediaDir: join(input.root, 'media'),
    cwd: input.cwd,
    deadConnection: (operation) =>
      `Switch refused ${operation}: this agent's connection (${input.connectionId}) had lapsed.`,
  };
  const posted = await callOperation(ctx, 'post_message', {
    body: input.body,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  });
  if (posted.isError) throw new Error(resultText(posted));
}

/**
 * Tells the room a session can't start and its message is kept, in one
 * of the agreed lines, which `line` builds with the agent owner's handle
 * when Switch gives one. A plain post: the line itself names the owner, so
 * they are addressed without a second mention, and never with the raw
 * failure.
 */
export async function announceKept(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  threadId: string | null;
  line: (owner: string | null) => string;
}): Promise<void> {
  const ctx: CallerContext = {
    identity: input.identity,
    connectionId: input.connectionId,
    selector: {
      [SESSION_SELECTOR_HEADERS.sessionId]: input.session.sessionId,
      [SESSION_SELECTOR_HEADERS.hostId]: input.session.hostId,
      [SESSION_SELECTOR_HEADERS.epoch]: input.session.epoch,
    },
    room: null,
    mediaDir: join(input.root, 'media'),
    cwd: input.cwd,
    deadConnection: (operation) =>
      `Switch refused ${operation}: this agent's connection (${input.connectionId}) had lapsed.`,
  };
  const detail = await callOperation(ctx, 'get_agent_detail', {
    agent_id: input.identity.agentId,
  });
  const found = detail.isError ? null : detail.structuredContent?.owner_name;
  const owner = typeof found === 'string' && found ? found : null;
  if (!owner)
    console.warn(
      `Could not find this agent's owner to name in the line about session ${input.session.sessionId} not starting${
        detail.isError ? ` (${resultText(detail)})` : ''
      }.`
    );
  const posted = await callOperation(ctx, 'post_message', {
    body: input.line(owner),
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  });
  if (posted.isError) throw new Error(resultText(posted));
}

/**
 * The launcher's one-time hub tickets for this launch: taken only with a good
 * HMAC under the launch's push key, read from the launcher's pipe at start.
 */
export class HubTickets {
  private hubTicket: string | null = null;
  private readonly ticketWaiters: ((ticket: string) => void)[] = [];
  private pushKey: Buffer | null = null;

  /** This launch's push key, read from the launcher's pipe at start. */
  setPushKey(key: Buffer): void {
    this.pushKey = key;
  }

  /**
   * A one-time hub ticket from the launcher, for the next hello; the
   * newest wins. Taken only with a good HMAC under this launch's push key, and
   * answered with the confirmation; anything else is ignored (null).
   */
  giveHubTicket(ticket: string, mac: string): string | null {
    if (!this.pushKey || !macEquals(mac, ticketMac(this.pushKey, ticket))) return null;
    const waiter = this.ticketWaiters.shift();
    if (waiter) waiter(ticket);
    else this.hubTicket = ticket;
    return takenMac(this.pushKey, ticket);
  }

  /** The ticket for the next hello, taken once; waits up to `timeoutMs` for one, else undefined. */
  takeHubTicket(timeoutMs: number): Promise<string | undefined> {
    if (this.hubTicket !== null) {
      const ticket = this.hubTicket;
      this.hubTicket = null;
      return Promise.resolve(ticket);
    }
    return new Promise((resolve) => {
      const waiter = (ticket: string) => {
        clearTimeout(timer);
        resolve(ticket);
      };
      const timer = setTimeout(() => {
        const at = this.ticketWaiters.indexOf(waiter);
        if (at >= 0) this.ticketWaiters.splice(at, 1);
        resolve(undefined);
      }, timeoutMs);
      timer.unref?.();
      this.ticketWaiters.push(waiter);
    });
  }
}

/** The box's `WatcherBox` for `sessionToolAnswerer` and `WatcherControl`. */
export function watcherBox(input: {
  held: HeldReplies;
  tickets: HubTickets;
  restartNotice?: RestartNotice;
}): WatcherBox {
  return {
    held: input.held,
    heldTools: HELD_TOOLS,
    restartNotice: input.restartNotice,
    alreadyInRoom,
    heldPost,
    tickets: input.tickets,
  };
}
