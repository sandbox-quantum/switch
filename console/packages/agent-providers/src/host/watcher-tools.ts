import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CallerContext,
  callOperation,
  loadOperations,
  SESSION_SELECTOR_HEADERS,
  SwitchToolCatalog,
  type SwitchIdentity,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime/hosted';
import { z } from 'zod';
import type { PlacementMap, SessionPlacements } from './placements';
import type { AskHandler, Caller } from './session-channel';
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
 * reaches it, and put back as it was if Switch refuses.
 */
export function sessionToolAnswerer(deps: {
  identity: SwitchIdentity;
  connectionId: string;
  placements: SessionPlacements;
  /** States every placement to Switch; raises when Switch does not take them. */
  publish: () => Promise<void>;
}): AskHandler {
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
    try {
      await deps.publish();
    } catch (error) {
      console.warn(
        `Switch did not take this agent's session placements after session ${caller.sessionId} connected to room ${roomId}: ${error instanceof Error ? error.message : String(error)}. They are stated again on the next change or reconnect.`
      );
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

  return async (caller, ask) => {
    const catalog = await tools();
    if (ask.type === 'tools') return catalog.tools();
    if (ask.name === 'connect_to_room') return connect(caller, catalog, ask.arguments);
    return catalog.call(await context(caller), ask.name, ask.arguments);
  };
}

function resultText(result: ToolResult): string {
  return result.content.map((part) => part.text).join('\n');
}

/** A call made as the session, in the room Switch holds it placed in. */
function asSession(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
}): CallerContext {
  return {
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
export async function announceStartFailure(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  threadId: string | null;
  failure: string;
}): Promise<void> {
  const ctx = asSession(input);
  const thread = input.threadId ? { thread_id: input.threadId } : {};
  const detail = await callOperation(ctx, 'get_agent_detail', {
    agent_id: input.identity.agentId,
  });
  const owner = detail.isError ? null : detail.structuredContent?.owner_name;
  if (typeof owner === 'string' && owner) {
    const targeted = await callOperation(ctx, 'send_targeted_message', {
      body: `I couldn't start a session, and it needs you to fix it: ${input.failure} Then address me again.`,
      target_names: [owner],
      ...thread,
    });
    if (!targeted.isError) return;
    console.warn(
      `Could not address this agent's owner (${owner}) about session ${input.session.sessionId} failing to start: ${resultText(targeted)}. Telling the room without addressing them.`
    );
    const posted = await callOperation(ctx, 'post_message', {
      body: `I couldn't start a session, and my owner (${owner}) needs to fix it: ${input.failure} Then address me again.`,
      ...thread,
    });
    if (posted.isError) throw new Error(resultText(posted));
    return;
  }
  console.warn(
    `Could not find this agent's owner to tell about session ${input.session.sessionId} failing to start${
      detail.isError ? ` (${resultText(detail)})` : ''
    }. Telling the room without addressing them.`
  );
  const posted = await callOperation(ctx, 'post_message', {
    body: `I couldn't start a session, and my owner needs to fix it: ${input.failure} Then address me again.`,
    ...thread,
  });
  if (posted.isError) throw new Error(resultText(posted));
}

/**
 * Tells a room that a control typed in it (`!reset`, `!interrupt`) was not
 * carried out, or that whether it was is not known: Switch answered the room
 * when it relayed the control, before the session had it. Addressed to
 * whoever asked when the room named them. Raises when the room could not be
 * told.
 */
export async function announceCommandOutcome(input: {
  identity: SwitchIdentity;
  connectionId: string;
  session: { sessionId: string; hostId: string; epoch: string };
  root: string;
  cwd: string;
  threadId: string | null;
  requesterName: string | null;
  body: string;
}): Promise<void> {
  const ctx = asSession(input);
  const thread = input.threadId ? { thread_id: input.threadId } : {};
  const body = input.body;
  if (input.requesterName) {
    const targeted = await callOperation(ctx, 'send_targeted_message', {
      body,
      target_names: [input.requesterName],
      ...thread,
    });
    if (!targeted.isError) return;
    console.warn(
      `Could not address ${input.requesterName} about a room control session ${input.session.sessionId} did not carry out: ${resultText(targeted)}. Telling the room without addressing them.`
    );
  }
  const posted = await callOperation(ctx, 'post_message', { body, ...thread });
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

export const watcherHealthSchema = z.object({
  state: watcherStateSchema,
  /** The stream's last error, why the watcher stopped, or why it stood down. */
  detail: z.string().nullable(),
  /** When `state` began, as an ISO timestamp. */
  since: z.string(),
  /** Session id → room id, as the watcher routes now. Empty while it is not running. */
  placements: z.record(z.string(), z.string()),
});
export type WatcherHealth = z.infer<typeof watcherHealthSchema>;

/** What a running watcher answers for, through its control. */
export type WatcherHandlers = {
  place: (sessionId: string, roomId: string) => Promise<PlaceOutcome>;
  forget: (sessionId: string) => Promise<void>;
};

/**
 * Reaches a running watcher from outside it: Console's "Reconnect to room",
 * locally by a direct call and remotely through the sidecar's control port;
 * and the watcher's own account of its connection and placements, which it
 * keeps current here.
 */
export class WatcherControl {
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
  }): void {
    const state = change.state ?? this.current.state;
    const same = state === this.current.state;
    const next: WatcherHealth = {
      state,
      detail: change.detail !== undefined ? change.detail : same ? this.current.detail : null,
      since: same ? this.current.since : new Date().toISOString(),
      placements: change.placements ? { ...change.placements } : this.current.placements,
    };
    if (
      same &&
      next.detail === this.current.detail &&
      samePlacements(next.placements, this.current.placements)
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

function samePlacements(a: PlacementMap, b: PlacementMap): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}
