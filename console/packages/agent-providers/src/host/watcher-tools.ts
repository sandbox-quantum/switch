import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CallerContext,
  loadOperations,
  SESSION_SELECTOR_HEADERS,
  SwitchToolCatalog,
  type SwitchIdentity,
  type ToolResult,
} from '@sandboxaq/switch-agent-runtime/hosted';
import type { SessionPlacements } from './placements';
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
 * Reaches a running watcher from outside it: Console's "Reconnect to room",
 * locally by a direct call and remotely through the sidecar's control port.
 */
export class WatcherControl {
  private placer: ((sessionId: string, roomId: string) => Promise<PlaceOutcome>) | null = null;

  /** Called by the watcher while it runs; the returned function unbinds it. */
  bind(placer: (sessionId: string, roomId: string) => Promise<PlaceOutcome>): () => void {
    if (this.placer) throw new Error('A room watcher is already bound to this control.');
    this.placer = placer;
    return () => {
      if (this.placer === placer) this.placer = null;
    };
  }

  /** Move a room's messages to this session. Refused when no watcher is running. */
  place(sessionId: string, roomId: string): Promise<PlaceOutcome> {
    if (!this.placer)
      return Promise.reject(
        new Error(
          "The agent's room watcher is not running, so no session can be moved to a room. Turn the agent's room connection on first."
        )
      );
    return this.placer(sessionId, roomId);
  }
}
