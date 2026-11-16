import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CallerContext,
  callOperation,
  callOperationOutcome,
  loadOperations,
  SESSION_SELECTOR_HEADERS,
  SwitchToolCatalog,
  type SwitchIdentity,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime-box/hosted';
import { z } from 'zod';
import {
  HELD_REPLY_LOST_LINE,
  HELD_REPLY_NOTICE,
  HELD_TOOLS,
  type HeldReplies,
  type ResendOutcome,
} from './held-replies';
import type { PlacementMap, SessionPlacements } from './placements';
import { macEquals, takenMac, ticketMac } from './push-key';
import type { Redactions } from './redaction';
import { issueServiceToken, readServiceGrants } from './service-access';
import { AgentServiceTokens } from './service-tokens';
import type { AskHandler, Caller, HostAsk } from './session-channel';
import { sharedConfigSchema } from './shared-config';

/**
 * The watcher's answer to its sessions' tool calls.
 *
 * Each session host serves the Switch tools to its CLI and forwards every
 * call here, the one process holding the agent's credentials and connection.
 * A call is made as the calling session: the agent's token, the watcher's
 * connection id, and the selector naming the session, its host and its
 * generation. `connect_to_room` is also a local move: the room is placed with
 * the calling session before Switch is asked, so the room's next message
 * reaches it, and put back as it was if Switch refuses. Behind an agent
 * controller, whose relay names each call's room from the placements, a move
 * the controller does not take is put back and refused as well: Switch only
 * checked membership, and the session would otherwise be told it connected
 * and then find every call made from no room.
 *
 * It also answers the sessions' asks for service tokens (`AgentServiceTokens`),
 * and scrubs every token handed out from the arguments of every call it makes,
 * so a token an agent echoes into a room message never reaches Switch.
 */
/**
 * Posts the "I was restarted" line for a turn through the agent's controller,
 * as the agent, keyed `restart:<turnId>` so Switch posts it once however
 * often it is asked. `unsupported` from a Switch server that predates it, so
 * the line goes the older way instead.
 */
export type RestartNotice = (notice: {
  roomId: string;
  threadId: string | null;
  turnId: string;
}) => Promise<'posted' | 'unsupported'>;

export function sessionToolAnswerer(deps: {
  /** Where the controller can post a restart line keyed by its turn; absent off a controller. */
  restartNotice?: RestartNotice;
  identity: SwitchIdentity;
  connectionId: string;
  placements: SessionPlacements;
  /** States every placement to Switch; raises when Switch does not take them. */
  publish: () => Promise<void>;
  /**
   * Whether a call's room is named from the stated placements rather than
   * recorded by Switch on `connect_to_room` (`AgentEventStream`).
   */
  placementsNameCallRooms: () => boolean;
  /** The service tokens handed out in this process, added to as more are. */
  redactions: Redactions;
  /**
   * Where a room post Switch could not take, because it was away, is held to
   * be sent again. Without it such a post fails to the agent as before.
   */
  held?: HeldReplies;
}): AskHandler {
  const services = new AgentServiceTokens({
    endpoint: deps.identity,
    redactions: deps.redactions,
    now: Date.now,
    issue: issueServiceToken,
    readGrants: readServiceGrants,
  });
  let catalog: Promise<SwitchToolCatalog> | null = null;
  const tools = (): Promise<SwitchToolCatalog> => {
    catalog ??= loadOperations(deps.identity).then(
      (operations) => new SwitchToolCatalog(operations),
      (error: unknown) => {
        catalog = null;
        throw error;
      }
    );
    return catalog;
  };

  const context = async (caller: Caller): Promise<CallerContext> => {
    const saved = sharedConfigSchema.parse(
      JSON.parse(await readFile(join(caller.root, 'config.json'), 'utf8'))
    );
    return {
      identity: deps.identity,
      connectionId: deps.connectionId,
      selector: {
        [SESSION_SELECTOR_HEADERS.sessionId]: caller.sessionId,
        [SESSION_SELECTOR_HEADERS.hostId]: caller.hostId,
        [SESSION_SELECTOR_HEADERS.epoch]: caller.epoch,
      },
      room: deps.placements.roomOf(caller.sessionId),
      mediaDir: join(caller.root, 'media'),
      cwd: saved.start.input.cwd,
      deadConnection: (operation) =>
        `Switch refused ${operation}: this agent's connection (${deps.connectionId}) had lapsed. ` +
        'The room watcher holding it reopens it within a few seconds — retry the call. If it ' +
        'keeps failing, the watcher has stopped; check the agent in Switch Console.',
    };
  };

  // One room move at a time, so the local map and Switch see moves in the
  // same order and a refused move restores the state it actually replaced.
  let moves: Promise<unknown> = Promise.resolve();
  const connect = (
    caller: Caller,
    catalog: SwitchToolCatalog,
    args: Record<string, unknown>
  ): Promise<ToolResult> => {
    const move = moves.then(() => connectNow(caller, catalog, args));
    moves = move.catch(() => {});
    return move;
  };
  const connectNow = async (
    caller: Caller,
    catalog: SwitchToolCatalog,
    args: Record<string, unknown>
  ): Promise<ToolResult> => {
    const roomId = args.room_id;
    const ctx = await context(caller);
    if (typeof roomId !== 'string' || !roomId) return catalog.call(ctx, 'connect_to_room', args);
    const before = deps.placements.snapshot();
    const { displaced } = await deps.placements.place(caller.sessionId, roomId);
    const result = await catalog.call(ctx, 'connect_to_room', args);
    if (result.isError) {
      await deps.placements.restore(before);
      return result;
    }
    let notTaken: string | null = null;
    try {
      await deps.publish();
      // A room the controller left out and named back (it does not count the
      // agent as in it yet) is taken off the session by the publish itself.
      if (deps.placementsNameCallRooms() && deps.placements.roomOf(caller.sessionId) !== roomId)
        notTaken = `the agent controller does not count room ${roomId} among this agent's rooms yet`;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // Over the agent's own connection Switch placed the session on connect,
      // and a later statement puts the copy right.
      if (deps.placementsNameCallRooms()) notTaken = reason;
      else
        console.warn(
          `Switch did not take this agent's session placements after session ${caller.sessionId} connected to room ${roomId}: ${reason}. They are stated again on the next change or reconnect.`
        );
    }
    if (notTaken !== null) {
      await deps.placements.restore(before);
      // So what the stream states on its next change or reconnect is the map
      // put back, not the move it did not take.
      await deps.publish().catch(() => {});
      console.warn(
        `The agent controller did not take session ${caller.sessionId}'s move to room ${roomId}: ${notTaken}. The move was put back and connect_to_room refused.`
      );
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text:
              'connect_to_room did not take effect: Switch accepted it, but the agent controller ' +
              `running this agent did not record the move to room ${roomId} (${notTaken}), so your ` +
              'calls would not be made from that room. Call connect_to_room again; if it keeps ' +
              "failing, the agent controller's log says why.",
          },
        ],
      };
    }
    if (!displaced) return result;
    const warning =
      `Room ${roomId} was being attended by another session of this agent on the same machine ` +
      `(${displaced}). That session no longer receives the room's messages; this one does. ` +
      'Work in progress there may have been interrupted.';
    console.warn(`Session ${caller.sessionId} took room ${roomId} from session ${displaced}.`);
    const previous = result.structuredContent?.warning;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: warning }],
      ...(result.structuredContent
        ? {
            structuredContent: {
              ...result.structuredContent,
              warning:
                typeof previous === 'string' && previous ? `${previous}\n${warning}` : warning,
            },
          }
        : {}),
    };
  };

  /**
   * Posts, as the session, a reply its turn left unposted. Only into the room
   * the turn came from, and only while the session still attends it: a post
   * goes to whichever room the session holds, and one it has moved to since
   * did not ask.
   */
  const roomReply = async (
    caller: Caller,
    catalog: SwitchToolCatalog,
    ask: Extract<HostAsk, { type: 'room-reply' }>
  ): Promise<null | { posted: boolean }> => {
    const attended = deps.placements.roomOf(caller.sessionId);
    if (attended !== ask.roomId)
      throw new Error(
        `Session ${caller.sessionId} no longer attends room ${ask.roomId}${attended ? ` (it attends ${attended})` : ''}, so its reply was not posted there.`
      );
    // The restart line, keyed by its turn through the controller: Switch
    // posts it once, so no room check is needed first.
    if (ask.restartTurnId && deps.restartNotice) {
      const outcome = await deps.restartNotice({
        roomId: ask.roomId,
        threadId: ask.threadId,
        turnId: ask.restartTurnId,
      });
      if (outcome === 'posted') return { posted: true };
    }
    // Stated again first: a reply is posted as the session, in the room Switch
    // holds it in, and the placement it was refused on may be the reason the
    // turn could not post itself.
    await deps
      .publish()
      .catch((error: unknown) =>
        console.warn(
          `Could not state the session placements before posting a reply for session ${caller.sessionId}: ${error instanceof Error ? error.message : String(error)}`
        )
      );
    const body = deps.redactions.text(ask.body);
    const ctx = await context(caller);
    // Raises when the room can't be read, so a reply is never posted blind.
    if (ask.once && (await alreadyInRoom(catalog, ctx, deps.identity.agentId, ask, body)))
      return { posted: false };
    const posted = await catalog.call(ctx, 'post_message', {
      body,
      ...(ask.threadId ? { thread_id: ask.threadId } : {}),
    });
    if (posted.isError) throw new Error(resultText(posted));
    return ask.once ? { posted: true } : null;
  };

  /**
   * A room post by the agent, under a key of its own from the first try, so
   * Switch posts it once however often it is sent. One that fails
   * because Switch is away is held and sent again under the same key when
   * Switch is back, and the agent is told so, rather than told it failed: a
   * failed post read as the turn's end left the room with no reply.
   */
  const post = async (
    caller: Caller,
    name: string,
    args: Record<string, unknown>,
    holder: HeldReplies
  ): Promise<ToolResult> => {
    const heldNotice: ToolResult = { content: [{ type: 'text', text: HELD_REPLY_NOTICE }] };
    // Sent again by an agent told it was held: still the one post.
    if (holder.heldLike(caller.sessionId, name, args)) return heldNotice;
    const roomId = deps.placements.roomOf(caller.sessionId);
    const key = `reply:${randomUUID()}`;
    const send = async (as: string, tool: string, sent: Record<string, unknown>) =>
      callOperationOutcome({ ...(await context(caller)), clientTxnId: as }, tool, sent);
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
      tellLost: () =>
        again(`${key}:lost`, 'post_message', { body: HELD_REPLY_LOST_LINE, ...thread }),
    });
    if (!held) return first.result;
    return heldNotice;
  };

  /**
   * The instructions of the room the session attends, read through
   * `connect_to_room`, which for an agent whose controller places its sessions
   * checks membership and returns the room's context without claiming
   * anything. Called directly rather than as the session's own connect: that
   * one also places the session, and a session that has moved on since the
   * message was handed over is not to be moved back.
   */
  const roomInstructions = async (
    caller: Caller,
    catalog: SwitchToolCatalog,
    ask: Extract<HostAsk, { type: 'room-instructions' }>
  ): Promise<{ instructions: string }> => {
    const attended = deps.placements.roomOf(caller.sessionId);
    if (attended !== ask.roomId)
      throw new Error(
        `Session ${caller.sessionId} no longer attends room ${ask.roomId}${attended ? ` (it attends ${attended})` : ''}, so its instructions were not read.`
      );
    const result = await catalog.call(await context(caller), 'connect_to_room', {
      room_id: ask.roomId,
      include_general_instructions: false,
    });
    if (result.isError) throw new Error(resultText(result));
    const instructions = result.structuredContent?.instructions;
    if (typeof instructions !== 'string')
      throw new Error(`connect_to_room answered for room ${ask.roomId} without its instructions.`);
    return { instructions: instructions.replace(ROOM_SECTION_HEADING, '').trim() };
  };

  return async (caller, ask) => {
    if (ask.type === 'service-token') return services.answer(ask.service, ask.rejected);
    const catalog = await tools();
    if (ask.type === 'tools') return catalog.tools();
    if (ask.type === 'room-reply') return roomReply(caller, catalog, ask);
    if (ask.type === 'room-instructions') return roomInstructions(caller, catalog, ask);
    const args = deps.redactions.value(ask.arguments);
    if (ask.name === 'connect_to_room') return connect(caller, catalog, args);
    if (deps.held && HELD_TOOLS.has(ask.name) && catalog.has(ask.name))
      return post(caller, ask.name, args, deps.held);
    return catalog.call(await context(caller), ask.name, args);
  };
}

/** The heading `connect_to_room` puts over a room's own instructions (`build_room_instructions`). */
const ROOM_SECTION_HEADING = /^## Room-specific instructions\s*/;

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
async function alreadyInRoom(
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

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join('\n');
}

/**
 * Tells a room that the session started to answer it could not start, and
 * why: as the agent, in the thread the message came from, and addressed to
 * the agent's owner, who is the one able to fix what stopped it (a provider
 * CLI that is not signed in, say). Raises when the room could not be told.
 *
 * The call is made as the session, so Switch must already know the room is
 * placed with it.
 */
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

/** The notice a room gets while a session starts to answer it. */
export const SESSION_STARTING_MESSAGE = 'Starting a session to handle this — one moment.';

/**
 * Tells the room a session is starting for its message, as the session that
 * will answer: in the thread the message was in, so the answer follows it.
 */
export async function announceSessionStart(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  threadId: string | null;
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
    body: SESSION_STARTING_MESSAGE,
    ...(input.threadId ? { thread_id: input.threadId } : {}),
  });
  if (posted.isError) throw new Error(resultText(posted));
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

/** What moving a room to a session did. */
export type PlaceOutcome = {
  sessionId: string;
  roomId: string;
  /** The room the session attended before, if another. */
  previous: string | null;
  /** The session that attended the room until now, if another. */
  displaced: string | null;
};

/**
 * Where a room watcher is with the agent's connection to Switch.
 *
 * - `not-running`: no watcher runs on this control (not started yet, or it
 *   stopped; `detail` says why when it failed).
 * - `disabled`: the watcher found the agent's room connection turned off and
 *   stopped.
 * - `taken-over`: the watcher stood down because another client holds the
 *   agent's connection.
 * - `connecting`: running, and the stream has not confirmed an open yet.
 * - `connected`: Switch confirmed the stream's open and it has not ended since.
 * - `disconnected`: an open failed or the open stream ended; it is retrying.
 */
export const watcherStateSchema = z.enum([
  'not-running',
  'disabled',
  'taken-over',
  'connecting',
  'connected',
  'disconnected',
]);
export type WatcherState = z.infer<typeof watcherStateSchema>;

/** Where one session stands, as Console shows it: Running, Back in a moment, or Resting. */
export const sessionStateSchema = z.enum(['active', 'waking', 'parked']);
export type SessionState = z.infer<typeof sessionStateSchema>;

function sameSessions(
  a: Record<string, SessionState> | undefined,
  b: Record<string, SessionState> | undefined
): boolean {
  if (!a || !b) return a === b;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

export const watcherHealthSchema = z.object({
  state: watcherStateSchema,
  /** The stream's last error, why the watcher stopped, or why it stood down. */
  detail: z.string().nullable(),
  /** When `state` began, as an ISO timestamp. */
  since: z.string(),
  /** Session id → room id, as the watcher routes now. Empty while it is not running. */
  placements: z.record(z.string(), z.string()),
  /**
   * The agent's sessions whose host runs here and is mid-turn, or has not yet
   * said whether it is. Absent from a watcher too old to report it.
   */
  busy: z.array(z.string()).optional(),
  /**
   * Each of the agent's sessions here: `active` while its host runs, `waking`
   * while it is being started for a message, `parked` while saved and
   * unloaded. Absent from a watcher too old to report it.
   */
  sessions: z.record(z.string(), sessionStateSchema).optional(),
  /**
   * Room messages waiting for room in a full box ("wait for room"): how many,
   * and since when the oldest. Absent from a watcher too old to report it.
   */
  waitingForRoom: z
    .object({ count: z.number().int().nonnegative(), oldestSince: z.string().nullable() })
    .optional(),
});
export type WatcherHealth = z.infer<typeof watcherHealthSchema>;

/** What a running watcher answers for, through its control. */
export type WatcherHandlers = {
  place: (sessionId: string, roomId: string) => Promise<PlaceOutcome>;
  forget: (sessionId: string) => Promise<void>;
  warm: (roomId: string) => Promise<string | null>;
  /**
   * The memory guard is stopping this agent: tell its rooms, and say how many
   * were told. Only an agent host under an agents controller has it.
   */
  stopForMemory?: () => Promise<number>;
};

/**
 * Reaches a running watcher from outside it: Console's "Reconnect to room",
 * locally by a direct call and remotely through the sidecar's control port;
 * and the watcher's own account of its connection and placements, which it
 * keeps current here.
 */
export class WatcherControl {
  /** How the watcher posts a restart line keyed by its turn, when it runs under a controller. */
  readonly restartNotice: RestartNotice | undefined;

  constructor(options: { restartNotice?: RestartNotice } = {}) {
    this.restartNotice = options.restartNotice;
  }

  private handlers: WatcherHandlers | null = null;
  private current: WatcherHealth = {
    state: 'not-running',
    detail: null,
    since: new Date().toISOString(),
    placements: {},
  };
  private readonly healthListeners = new Set<(health: WatcherHealth) => void>();

  /** Called by the watcher while it runs; the returned function unbinds it. */
  bind(handlers: WatcherHandlers): () => void {
    if (this.handlers) throw new Error('A room watcher is already bound to this control.');
    this.handlers = handlers;
    return () => {
      if (this.handlers === handlers) this.handlers = null;
    };
  }

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

  /** Whether a watcher is running behind this control. */
  get running(): boolean {
    return this.handlers !== null;
  }

  /**
   * Forget a session Console deleted: stop its host, take its rooms off it,
   * drop what was queued for it and remove its state, so the room's next
   * message starts a new session rather than reaching the deleted one.
   * Refused when no watcher is running.
   */
  forget(sessionId: string): Promise<void> {
    if (!this.handlers)
      return Promise.reject(new Error("The agent's room watcher is not running."));
    return this.handlers.forget(sessionId);
  }

  /** Move a room's messages to this session. Refused when no watcher is running. */
  place(sessionId: string, roomId: string): Promise<PlaceOutcome> {
    if (!this.handlers)
      return Promise.reject(
        new Error(
          "The agent's room watcher is not running, so no session can be moved to a room. Turn the agent's room connection on first."
        )
      );
    return this.handlers.place(sessionId, roomId);
  }

  /**
   * Start the session a message to this room would start, or confirm the one
   * placed there, without a message: a chat just created or reopened.
   * Resolves to that session, or null when the agent may not start one.
   * Refused when no watcher is running.
   */
  warm(roomId: string): Promise<string | null> {
    if (!this.handlers)
      return Promise.reject(new Error("The agent's room watcher is not running."));
    return this.handlers.warm(roomId);
  }

  /**
   * The agents controller's memory guard is about to stop this agent: its
   * rooms are told once (`memory-stop.ts`). Resolves to how many were told.
   * Refused when no watcher is running.
   */
  stopForMemory(): Promise<number> {
    if (!this.handlers?.stopForMemory)
      return Promise.reject(new Error("The agent's room watcher is not running."));
    return this.handlers.stopForMemory();
  }

  health(): WatcherHealth {
    return this.current;
  }

  /** Called with the new state after every change; the returned function stops it. */
  onHealth(listener: (health: WatcherHealth) => void): () => void {
    this.healthListeners.add(listener);
    return () => this.healthListeners.delete(listener);
  }

  /**
   * Called by the watcher as its state changes. A new state without a `detail`
   * clears the old one; `since` moves only when the state does.
   */
  report(change: {
    state?: WatcherState;
    detail?: string | null;
    placements?: PlacementMap;
    busy?: string[];
    sessions?: Record<string, SessionState>;
    waitingForRoom?: { count: number; oldestSince: string | null };
  }): void {
    const state = change.state ?? this.current.state;
    const same = state === this.current.state;
    const next: WatcherHealth = {
      state,
      detail: change.detail !== undefined ? change.detail : same ? this.current.detail : null,
      since: same ? this.current.since : new Date().toISOString(),
      placements: change.placements ? { ...change.placements } : this.current.placements,
      ...(change.busy
        ? { busy: [...change.busy].sort() }
        : this.current.busy
          ? { busy: this.current.busy }
          : {}),
      ...(change.sessions
        ? { sessions: { ...change.sessions } }
        : this.current.sessions
          ? { sessions: this.current.sessions }
          : {}),
      ...(change.waitingForRoom
        ? { waitingForRoom: { ...change.waitingForRoom } }
        : this.current.waitingForRoom
          ? { waitingForRoom: this.current.waitingForRoom }
          : {}),
    };
    if (
      same &&
      next.detail === this.current.detail &&
      samePlacements(next.placements, this.current.placements) &&
      sameList(next.busy, this.current.busy) &&
      sameSessions(next.sessions, this.current.sessions) &&
      next.waitingForRoom?.count === this.current.waitingForRoom?.count &&
      next.waitingForRoom?.oldestSince === this.current.waitingForRoom?.oldestSince
    )
      return;
    this.current = next;
    for (const listener of this.healthListeners) {
      try {
        listener(next);
      } catch (error) {
        console.error(`A room watcher health listener failed: ${String(error)}`);
      }
    }
  }
}

function sameList(a: string[] | undefined, b: string[] | undefined): boolean {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function samePlacements(a: PlacementMap, b: PlacementMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
