import * as os from 'node:os';
import * as path from 'node:path';
import { deriveAgentStatus } from '@main/core/agent-hooks/derive-agent-status';
import type { ContextResolver, ParsedHookEvent } from '@main/core/agent-hooks/event-enricher';
import { parseHookEvent } from '@main/core/agent-hooks/event-enricher';
import type { RawHookRequest } from '@main/core/agent-hooks/hook-server';
import { PluginPromptInjector } from '@main/core/switch-rooms/plugin-prompt-injector';
import {
  RoomConnection,
  type RoomConnectionDeps,
  type RoomConnectionLogger,
  type SwitchCredentials,
} from '@main/core/switch-rooms/room-connection';
import { sessionConnectionId } from '@main/core/switch-rooms/session-connection-id';
import { resolveSessionControl } from '@main/core/switch-rooms/session-control';
import { type TmuxRun, TmuxInjectionSink } from '@main/core/switch-rooms/tmux-injection-sink';
import { parsePtyId } from '@shared/core/pty/ptyId';
import { makeAgentTmuxSessionName } from './vm-tmux';

/** A live per-room connection — the slice of RoomConnection the runtime drives. */
export interface ManagedConnection {
  start(): void;
  stop(): void;
  onAgentStatusChange(
    status: Parameters<RoomConnection['onAgentStatusChange']>[0],
    notificationType?: Parameters<RoomConnection['onAgentStatusChange']>[1]
  ): void;
  reportActivity(detail: string): void;
  /** The connection id this session's tool calls are expected to arrive on. */
  readonly connection: string;
}

export type RoomConnectionFactory = (deps: RoomConnectionDeps) => ManagedConnection;

export const defaultRoomConnectionFactory: RoomConnectionFactory = (deps) =>
  new RoomConnection(deps);

export interface SidecarRuntimeDeps {
  creds: SwitchCredentials;
  deeplinkScheme: string;
  tmuxRun: TmuxRun;
  /** Whether a given agent tmux target is currently live (poller-backed cache). */
  isPaneLive: (tmuxTarget: string) => boolean;
  log: RoomConnectionLogger;
  createConnection: RoomConnectionFactory;
  /** Durable registry of the sessions this sidecar owns. Backed by the state
   * file so ownership survives a restart, rather than being rebuilt only as
   * each session happens to post its next hook. */
  registry: SessionRegistry;
}

/** The slice of the durable state store the runtime needs. */
export interface SessionRegistry {
  has(sessionId: string): boolean;
  record(entry: {
    sessionId: string;
    roomId: string | null;
    providerId: string;
    tmuxTarget: string;
  }): void;
  forget(sessionId: string): void;
}

interface SessionConnection {
  connection: ManagedConnection;
  /** Null for a session whose connection is open but whose room the server has
   * not named yet — `connectRoom` already branches on exactly that state. */
  roomId: string | null;
  tmuxTarget: string;
}

/**
 * The remote sidecar's manager: receives every session's agent-CLI hook
 * callbacks over one local HTTP server and drives, per session, a tmux-backed
 * RoomConnection injecting into that session's own pane. Multi-session — the
 * single agent-scoped sidecar serves every session on the VM (the one switchdash
 * started over SSH, and any the notification watcher auto-starts), each keyed by
 * its session id, so there is exactly one sidecar per agent rather than one
 * per session.
 *
 * Runs entirely on the VM with no database or Electron — the agent's Switch
 * credentials come from its `.claude/settings.local.json`.
 */
export class SidecarRuntime {
  /** sessionId → its live room connection. */
  private readonly sessions = new Map<string, SessionConnection>();
  private readonly resolveContext: ContextResolver;
  /** Notified when a session connects to a room, so the notification watcher can
   * hand its per-room in-flight guard off to the live-room check (mirrors the
   * local AutoSessionWatcher's room-connection subscription). */
  private roomConnectedListener: ((roomId: string, sessionId: string) => void) | null = null;

  constructor(private readonly deps: SidecarRuntimeDeps) {
    this.resolveContext = async (ptyId) => {
      const parsed = parsePtyId(ptyId);
      if (!parsed) return null;
      return {
        sessionId: parsed.sessionId,
        providerId: parsed.providerId,
        ptyId,
      };
    };
  }

  /**
   * Register the room-connected listener (the notification watcher's guard
   * hand-off).
   *
   * Carries the session id as well as the room because the spawn guards are
   * keyed differently: the watcher's in-flight guard by room, the spawner's
   * launched-session entry by session. Both end at the moment a session
   * connects, and after that the runtime's own room map is the only thing that
   * should decide whether a room is covered.
   */
  onRoomConnected(listener: (roomId: string, sessionId: string) => void): void {
    this.roomConnectedListener = listener;
  }

  /** Handle one raw hook callback from an agent CLI. Never throws. */
  async handleHook(raw: RawHookRequest): Promise<void> {
    // Every hook posted to THIS sidecar comes from a session it owns (the
    // session's hook env points here), so record its session id. This is
    // how `/sessions` scopes the VM-wide tmux enumeration to this agent's own
    // panes — tmux session names carry no repo/agent, so without this a sidecar
    // would report other agents' sessions on the same host.
    const pid = parsePtyId(raw.ptyId);
    if (pid) {
      this.deps.registry.record({
        sessionId: pid.sessionId,
        roomId: null,
        providerId: pid.providerId,
        tmuxTarget: makeAgentTmuxSessionName(pid.sessionId),
      });
    }

    let parsed: ParsedHookEvent;
    try {
      parsed = await parseHookEvent(raw, this.resolveContext, this.deps.log);
    } catch (error) {
      this.deps.log.warn('SidecarRuntime: failed to parse hook event', {
        type: raw.type,
        error: String(error),
      });
      return;
    }

    if (parsed.kind === 'switch-room') {
      this.connectRoom(parsed.ctx.sessionId, parsed.ctx.providerId, parsed.roomId, parsed.roomName);
      return;
    }

    if (parsed.kind === 'status') {
      const status = deriveAgentStatus(parsed.event);
      if (!status) return;
      const notificationType =
        parsed.event.type === 'notification' ? parsed.event.payload.notificationType : undefined;
      // Route to the session the event came from — not every connection.
      const session = this.sessions.get(parsed.event.sessionId);
      session?.connection.onAgentStatusChange(status, notificationType);
      return;
    }

    if (parsed.kind === 'activity') {
      const session = this.sessions.get(parsed.ctx.sessionId);
      session?.connection.reportActivity(parsed.detail);
      return;
    }
    // 'session' | 'ignore' → no-op: the VM persists no provider-session id and
    // has no database to update.
  }

  /**
   * Open a session's connection before it launches, and return the id to hand
   * it in its environment. Mirrors switchdash's `ensureForSession`.
   *
   * The connection must exist before the session's first `connect_to_room`,
   * which arrives tagged with this id. It also makes the room server-driven
   * here too: the claim lands on this connection and comes back as
   * `subscription_changed`, so the sidecar stops depending on parsing the hook.
   *
   * `roomId` is the room the session is being launched for, when it is being
   * launched for one — an auto-started session always is. Declaring it opens
   * the connection already claiming that room, so the session belongs to it
   * from the start instead of from whenever the agent calls connect_to_room.
   * Null for a session opened without a room in mind.
   */
  ensureForSession(
    sessionId: string,
    providerId: string,
    roomId: string | null,
    startCursor?: number
  ): string {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing.connection.connection;
    return this.openConnection(sessionId, providerId, roomId, null, startCursor);
  }

  private connectRoom(
    sessionId: string,
    providerId: string,
    roomId: string,
    roomName: string | null
  ): void {
    const existing = this.sessions.get(sessionId);
    // A repeat connect to the same room by the same session is a no-op so the
    // in-flight queue and renew loop are preserved — but still hand off the
    // watcher's spawn guard (idempotent), since a session is attending the room.
    if (existing && existing.roomId === roomId) {
      this.roomConnectedListener?.(roomId, sessionId);
      return;
    }
    if (existing && existing.roomId === null) {
      // We opened this connection at launch and the server has not named a
      // room yet. The claim is in flight; trust it rather than rebuilding.
      this.deps.log.debug('SidecarRuntime: hook named a room before the server did', {
        sessionId,
        roomId,
      });
      this.roomConnectedListener?.(roomId, sessionId);
      return;
    }
    // A session re-targeting to a new room supersedes ITS OWN prior room only —
    // other sessions' connections are untouched (mirrors each session's
    // connect_to_room re-targeting independently).
    if (existing) existing.connection.stop();

    this.openConnection(sessionId, providerId, roomId, roomName);
    this.roomConnectedListener?.(roomId, sessionId);
  }

  private openConnection(
    sessionId: string,
    providerId: string,
    roomId: string | null,
    roomName: string | null,
    startCursor?: number
  ): string {
    const tmuxTarget = makeAgentTmuxSessionName(sessionId);
    // Derived, not random: the session's pane outlives this process and keeps
    // stamping the id it was launched with, so a restarted sidecar has to
    // recompute that id rather than mint one the agent will never hear about.
    const connectionId = sessionConnectionId(sessionId);
    const connection = this.deps.createConnection({
      creds: this.deps.creds,
      roomId,
      roomName,
      connectionId,
      startCursor,
      sessionId,
      sink: new TmuxInjectionSink(tmuxTarget, this.deps.tmuxRun, () =>
        this.deps.isPaneLive(tmuxTarget)
      ),
      injector: new PluginPromptInjector(providerId),
      control: resolveSessionControl(providerId),
      deeplinkScheme: this.deps.deeplinkScheme,
      // The sidecar has no in-process signal for an attached operator's
      // keystrokes (those go through switchdash's main process over SSH), so it
      // can't gate on human typing yet — a known follow-up for the attached case.
      isHumanTyping: () => false,
      mediaDir: path.join(os.tmpdir(), 'switchdash-switch-media', sessionId),
      // The server naming this connection's room is what records it here, so a
      // session that moves rooms is followed without re-reading a hook.
      onRoomChanged: (room) => {
        const entry = this.sessions.get(sessionId);
        if (entry) entry.roomId = room;
        if (room) {
          this.deps.registry.record({ sessionId, roomId: room, providerId, tmuxTarget });
          this.roomConnectedListener?.(room, sessionId);
        }
      },
      log: this.deps.log,
    });
    this.sessions.set(sessionId, { connection, roomId, tmuxTarget });
    if (roomId) this.deps.registry.record({ sessionId, roomId, providerId, tmuxTarget });
    // The other end of the watcher's hand-off. If a spawned session comes up
    // without the message that triggered it, this says whether a cursor was
    // handed over and honoured, or whether it opened at head and read past it.
    this.deps.log.info('SidecarRuntime: connection opened', {
      event: 'switch_session_connection_open',
      sessionId,
      roomId,
      roomName,
      connectionId,
      startFrom: startCursor ?? 'head',
    });
    connection.start();
    return connectionId;
  }

  /**
   * Re-establish a room connection for a session restored from durable state.
   *
   * Without this a restarted sidecar would sit idle for every session it just
   * restored, resuming poll and injection only when that agent next posted a
   * hook — which an agent waiting on a room message never does. The room
   * membership itself is server-side and outlived the restart; only our
   * connection to it did not.
   */
  restoreSession(entry: { sessionId: string; roomId: string; providerId: string }): void {
    this.connectRoom(entry.sessionId, entry.providerId, entry.roomId, null);
  }

  /** The room a session is currently attending, or null if it has none. */
  roomIdForSession(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.roomId ?? null;
  }

  /**
   * Drop one session's room connection: stop its RoomConnection (which ends the
   * poll + renew heartbeat that keeps the agent marked live) and forget it, so
   * `/sessions` no longer reports it. Called when switchdash deletes the session.
   */
  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.connection.stop();
    this.sessions.delete(sessionId);
    this.deps.registry.forget(sessionId);
    this.deps.log.debug('SidecarRuntime: session stopped', { sessionId });
  }

  /** Agent tmux targets the runtime is currently injecting into (for pane-liveness polling). */
  activeTmuxTargets(): string[] {
    return [...this.sessions.values()].map((s) => s.tmuxTarget);
  }

  /**
   * Sessions the runtime has connected to a room, for switchdash to reconcile
   * into its UI. Only panes that are still live are reported so a session whose
   * agent has exited does not surface as a ghost row — and only sessions whose
   * room the server has actually named, since a room-less one has nothing for
   * switchdash to reconcile against.
   */
  connectedSessions(): Array<{ sessionId: string; roomId: string }> {
    const out: Array<{ sessionId: string; roomId: string }> = [];
    for (const [sessionId, session] of this.sessions) {
      const roomId = session.roomId;
      if (roomId && this.deps.isPaneLive(session.tmuxTarget)) {
        out.push({ sessionId, roomId });
      }
    }
    return out;
  }

  /** Whether this sidecar owns the session — i.e. it is one of this agent's own
   * sessions rather than another agent's pane on the same host. Backed by the
   * durable registry, so it is true from boot for a restored session instead of
   * only once that session next posts a hook. */
  hasSeen(sessionId: string): boolean {
    return this.deps.registry.has(sessionId);
  }

  /** True when a live session is attending the room and its pane is up (watcher gate). */
  hasLiveRoom(roomId: string): boolean {
    for (const session of this.sessions.values()) {
      if (session.roomId === roomId && this.deps.isPaneLive(session.tmuxTarget)) return true;
    }
    return false;
  }

  stop(): void {
    for (const session of this.sessions.values()) session.connection.stop();
    this.sessions.clear();
  }
}
