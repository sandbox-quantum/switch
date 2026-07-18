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
}

interface SessionConnection {
  connection: ManagedConnection;
  roomId: string;
  tmuxTarget: string;
}

/**
 * The remote sidecar's manager: receives every session's agent-CLI hook
 * callbacks over one local HTTP server and drives, per session, a tmux-backed
 * RoomConnection injecting into that session's own pane. Multi-session — the
 * single agent-scoped sidecar serves every session on the VM (the one switchdash
 * started over SSH, and any the notification watcher auto-starts), each keyed by
 * its conversation id, so there is exactly one sidecar per agent rather than one
 * per session.
 *
 * Runs entirely on the VM with no database or Electron — the agent's Switch
 * credentials come from its `.claude/settings.local.json`.
 */
export class SidecarRuntime {
  /** sessionId → its live room connection. */
  private readonly sessions = new Map<string, SessionConnection>();
  /** Every conversation id that has posted a hook to this sidecar — i.e. the
   * sessions it owns, used to scope the VM-wide tmux enumeration in `/sessions`. */
  private readonly seen = new Set<string>();
  private readonly resolveContext: ContextResolver;

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

  /** Handle one raw hook callback from an agent CLI. Never throws. */
  async handleHook(raw: RawHookRequest): Promise<void> {
    // Every hook posted to THIS sidecar comes from a session it owns (the
    // session's hook env points here), so record its conversation id. This is
    // how `/sessions` scopes the VM-wide tmux enumeration to this agent's own
    // panes — tmux session names carry no repo/agent, so without this a sidecar
    // would report other agents' sessions on the same host.
    const pid = parsePtyId(raw.ptyId);
    if (pid) this.seen.add(pid.sessionId);

    let parsed: ParsedHookEvent;
    try {
      parsed = await parseHookEvent(raw, this.resolveContext);
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

  private connectRoom(
    sessionId: string,
    providerId: string,
    roomId: string,
    roomName: string | null
  ): void {
    const existing = this.sessions.get(sessionId);
    // A repeat connect to the same room by the same session is a no-op so the
    // in-flight queue and renew loop are preserved.
    if (existing && existing.roomId === roomId) return;
    // A session re-targeting to a new room supersedes ITS OWN prior room only —
    // other sessions' connections are untouched (mirrors each session's
    // connect_to_room re-targeting independently).
    if (existing) existing.connection.stop();

    const tmuxTarget = makeAgentTmuxSessionName(sessionId);
    const connection = this.deps.createConnection({
      creds: this.deps.creds,
      roomId,
      roomName,
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
      log: this.deps.log,
    });
    this.sessions.set(sessionId, { connection, roomId, tmuxTarget });
    this.deps.log.debug('SidecarRuntime: room connected', { sessionId, roomId, roomName });
    connection.start();
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
    this.deps.log.debug('SidecarRuntime: session stopped', { sessionId });
  }

  /** Agent tmux targets the runtime is currently injecting into (for pane-liveness polling). */
  activeTmuxTargets(): string[] {
    return [...this.sessions.values()].map((s) => s.tmuxTarget);
  }

  /**
   * Sessions the runtime has connected to a room, for switchdash to reconcile
   * into its UI. Only panes that are still live are reported so a session whose
   * agent has exited does not surface as a ghost row.
   */
  connectedSessions(): Array<{ sessionId: string; roomId: string }> {
    const out: Array<{ sessionId: string; roomId: string }> = [];
    for (const [sessionId, session] of this.sessions) {
      if (this.deps.isPaneLive(session.tmuxTarget)) {
        out.push({ sessionId, roomId: session.roomId });
      }
    }
    return out;
  }

  /** Whether a conversation has ever posted a hook to this sidecar (i.e. it is
   * one of this agent's own sessions, not another agent's pane on the host). */
  hasSeen(sessionId: string): boolean {
    return this.seen.has(sessionId);
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
