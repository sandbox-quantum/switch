import * as fs from 'node:fs';
import * as path from 'node:path';
import { SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import type { AgentStatus, NotificationType } from '@shared/core/providers/agentEvents';
import type { InjectionSink } from './injection-sink';
import type { SessionControl } from './session-control';
import {
  formatEventForInjection,
  formatAttachmentAnnotation,
  type AgentBridgeEvent,
  type AttachmentRef,
  type CommandPayload,
  type MessagePayload,
} from './switch-event-format';

// Per-request timeouts. Without these a fetch on a half-open socket (e.g. during
// a brief ALB 5xx blip) can hang forever with no response and no error, wedging
// the await-each-tick loop it runs in. Every fetch is bounded so a hang aborts
// and the surrounding loop continues.
//
// Liveness no longer depends on these: the event stream and its heartbeat live
// in SwitchEventStream, which owns its own timeouts and reconnect. What remains
// here is the out-of-band reporting — runtime state and media downloads.
const RUNTIME_STATE_REQUEST_TIMEOUT_MS = 10_000;
const MEDIA_REQUEST_TIMEOUT_MS = 30_000;
// Safety net for the dialog gate: if a blocking prompt (permission/elicitation)
// never reports resolution, release the gate after this long so queued messages
// can't get permanently stuck. Normal turns are never gated.
const BUSY_FALLBACK_MS = 60_000;
// How long to wait before re-checking the dual-writer gate while the operator
// is typing into the pane. Short enough that delivery resumes promptly once
// they pause.
const HUMAN_GATE_RETRY_MS = 500;
// Gap between steps of a multi-step control command (e.g. reset's `/clear` then
// the reconnect prompt), so a TUI settles one before the next is typed.
const CONTROL_STEP_GAP_MS = 600;
// While a turn is working, re-push the activity line this often with a refreshed
// elapsed-time suffix (e.g. "· 15s") so a long-running step visibly ticks.
const ACTIVITY_TICK_INTERVAL_MS = 5_000;

export type SwitchCredentials = { agentId: string; apiEndpoint: string; token: string };

/** Make an attachment filename safe to use as a local path segment. */
function sanitiseAttachmentName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_') || 'attachment';
}

/** Compact elapsed label from a millisecond duration: "8s", "1m03s", "2h05m". */
function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  if (total < 60) return `${total}s`;
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins < 60) return `${mins}m${String(secs).padStart(2, '0')}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h${String(mins % 60).padStart(2, '0')}m`;
}

/**
 * The runtime states switch-core surfaces on bridged channels. The richer
 * per-session `AgentStatus` is collapsed onto these before reporting:
 * `completed` → `idle` (work done, nothing to surface) and `error` →
 * `awaiting-input` (needs the operator's attention).
 */
type RuntimeState = 'working' | 'awaiting-input' | 'idle';

function toRuntimeState(status: AgentStatus): RuntimeState {
  switch (status) {
    case 'working':
      return 'working';
    case 'awaiting-input':
    case 'error':
      return 'awaiting-input';
    case 'completed':
    case 'idle':
      return 'idle';
  }
}

/**
 * Whether keystrokes must NOT be injected right now. Only a genuine blocking
 * dialog qualifies — a permission prompt or MCP elicitation — where the injected
 * text and trailing Enter would be consumed by the dialog instead of the prompt
 * box.
 *
 * We deliberately do NOT gate on `working`: Claude queues input typed while it is
 * mid-turn, so injecting then just enqueues the message for the next turn. Gating
 * on `working` is what wedged sessions whenever a turn never reported completion
 * — most visibly a manual ESC interrupt, which fires no hook at all, leaving the
 * status stuck at `working`. An `idle_prompt` notification also maps to
 * `awaiting-input` but is just Claude idling at its ready prompt — safe to inject.
 */
function isBlockingStatus(
  status: AgentStatus | null,
  notificationType?: NotificationType
): boolean {
  return status === 'awaiting-input' && notificationType !== 'idle_prompt';
}

interface QueuedInjection {
  text: string;
  /** True for addressed messages — drives the room "typing" indicator. */
  addressed: boolean;
  /**
   * The triggering message's thread id (its `thread_id`) when it was in a
   * thread, so the bridge surfaces runtime state in that thread. null at the
   * room root.
   */
  threadId: string | null;
  /**
   * The message's own id. Reported to the bridge once this injection actually
   * reaches the session, so the runtime indicator only moves below a message
   * the agent has really been handed.
   */
  messageId: string | null;
}

/** Provider-specific keystroke payload builder, injected to keep the core free
 * of the plugin registry (which is unavailable in the remote sidecar). */
export interface PromptInjector {
  build(text: string): { payload: string; submitSequence: string; submitDelayMs: number };
}

export interface RoomConnectionLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RoomConnectionDeps {
  creds: SwitchCredentials;
  /**
   * The room the session is already known to be in, if we happen to know —
   * restoring after a restart, or an adopted session whose hook told us. Null
   * for a session we just launched: it has not connected to a room yet, and
   * when it does the server tells us on the stream.
   */
  roomId: string | null;
  roomName: string | null;
  /**
   * The connection id this session uses, minted before launch and handed to the
   * session in its environment so its tool calls land on this same connection.
   * Stable across room changes and reconnects — that is what makes the room
   * repointable instead of requiring a new connection each time.
   */
  connectionId: string;
  /**
   * Where this session's stream should begin, when head is wrong. Set when a
   * watcher spawned the session to answer a specific message: that message is
   * already behind head, so starting there would skip the one thing the
   * session exists to handle.
   */
  startCursor?: number;
  /** The Switch Console session id of the session this connection drives, so
   * the deeplink can resolve to the exact session on any client (the shared
   * session id is the same across clients; the local room mapping is not). */
  sessionId: string;
  sink: InjectionSink;
  injector: PromptInjector;
  /** Per-agent-type session-control support + keystroke recipes (reset /
   * compact / interrupt). Its capabilities are reported to the bridge; its
   * plans drive execution of queued `command` events. */
  control: SessionControl;
  /** OS URL scheme for the `<scheme>://session?…` deeplink (e.g. `switchdash`). */
  deeplinkScheme: string;
  /**
   * Dual-writer gate: true while a human is actively typing into the pane, so
   * injection defers rather than interleaving with their keystrokes. The local
   * poller wires this to operator PTY input; the remote sidecar has no
   * in-process signal for an attached operator yet, so it passes `() => false`.
   */
  isHumanTyping: () => boolean;
  /**
   * Directory to materialise inbound image attachments into so the agent can
   * Read them. Local files, mirroring the connector channel's media dir; each
   * environment supplies its own (a Switch Console temp dir locally, a VM-local
   * temp dir in the sidecar).
   */
  mediaDir: string;
  /**
   * Called when the server reports which room this connection covers — on
   * connect, and again whenever it changes. This is how Switch Console learns a
   * session's room: from Switch, on the connection the session's own
   * `connect_to_room` call landed on.
   */
  onRoomChanged?: (roomId: string | null) => void;
  log: RoomConnectionLogger;
}

/**
 * One **session's** connection to Switch: receives its room's events on the
 * agent bridge's push stream, injects addressed messages / task events into the
 * session via an `InjectionSink`, and reports runtime state back to the bridge.
 * Transport-agnostic — the local main process drives it with a PTY-backed sink,
 * the remote sidecar with a tmux-backed one.
 *
 * Delivery and liveness both belong to `SwitchEventStream`: one SSE connection
 * and one heartbeat, in place of the long-poll and the three renew loops
 * (`/connection/renew`, `/leases/renew`, `/watch/heartbeat`) this used to run.
 * The connection survives a dropped socket, so a reconnect resumes from the
 * cursor rather than losing whatever arrived while it was away — the poll had
 * no cursor at all and the server drained its queue on read.
 *
 * **The room is not fixed and is not ours to decide.** The connection belongs
 * to the session and merely points at whichever room the session is in; the
 * server says which, on this connection's own stream. When the session calls
 * `connect_to_room`, the server claims the room on the connection the call came
 * in on — this one, when the session was handed our id at launch — and tells us
 * as `subscription_changed`. Before that arrived from the server we learned the
 * room by reading the agent's tool response through a hook, which broke
 * silently the moment that response changed shape.
 */
export class RoomConnection {
  private readonly creds: SwitchCredentials;
  /** The room this session is currently in, or null before the server says. */
  private roomId: string | null;
  private roomName: string | null;
  private readonly sessionId: string;
  private readonly sink: InjectionSink;
  private readonly injector: PromptInjector;
  private readonly control: SessionControl;
  private readonly deeplinkScheme: string;
  private readonly isHumanTyping: () => boolean;
  private readonly mediaDir: string;
  private readonly log: RoomConnectionLogger;

  private readonly abort = new AbortController();
  private readonly queue: QueuedInjection[] = [];
  private stopped = false;
  private busy = false;
  /** Last runtime state we pushed to the bridge, to avoid redundant calls. */
  private runtimeState: RuntimeState = 'idle';
  /**
   * True while the session is handling a turn kicked off by an addressed room
   * message. Only then does runtime state surface to the room — local TUI work
   * (or any non-room activity) must not show "working on it" in the channel.
   */
  private roomTurnActive = false;
  /** Thread of the current room turn (see QueuedInjection.threadId). */
  private currentThreadId: string | null = null;
  /**
   * The last message actually delivered into the session. Reported with runtime
   * state so the bridge can position the indicator below what the agent has
   * genuinely received — a message that merely arrived in the room must not
   * make the indicator claim the agent has seen it.
   */
  private currentAnchorId: string | null = null;
  /** Last activity line (without the elapsed suffix), to skip redundant refreshes. */
  private lastActivityDetail: string | null = null;
  /** Monotonic timestamp the current working turn began, for the elapsed suffix. */
  private workingStartedAt = 0;
  /** Ticker that re-pushes the activity line with a refreshed elapsed suffix. */
  private activityTicker: ReturnType<typeof setInterval> | null = null;
  private busyFallback: ReturnType<typeof setTimeout> | null = null;
  private humanGateTimer: ReturnType<typeof setTimeout> | null = null;
  /** The push transport: one SSE stream plus one heartbeat, replacing the
   * long-poll and the three renew loops. */
  private stream: SwitchEventStream | null = null;
  /** Minted before launch and shared with the session, so its tool calls land
   * on this connection. Reused across reconnects, so the server-side
   * connection — and with it the room slot and role lease — survives a dropped
   * socket. */
  private readonly connectionId: string;
  private readonly startCursor: number | undefined;
  /** Notified whenever the server tells us which room this session is in. */
  private readonly onRoomChanged: ((roomId: string | null) => void) | null;
  /**
   * The last room we passed to `onRoomChanged`. Deliberately not seeded from
   * the declared room: a connection opened declaring one is *told* the same
   * room back on the `connected` frame, and deduping that against the declared
   * value would swallow the server's first word — leaving the session's room
   * known here but never reported to anyone.
   */
  private reportedRoom: string | null = null;
  /** Unaddressed room messages filtered out since the last event we surfaced. */
  private missed = 0;
  /**
   * Reason from the most recent gap, held until the next event we surface.
   *
   * Not injected on its own: a gap is a maybe — the agent cannot tell whether
   * anything it cared about was dropped — and interrupting a session to report
   * a maybe costs a turn every time the stream hiccups. Carried on the next
   * real event instead, which is still before any reply stale context could
   * skew.
   */
  private pendingGapReason: string | null = null;

  constructor(deps: RoomConnectionDeps) {
    this.creds = deps.creds;
    this.roomId = deps.roomId;
    this.roomName = deps.roomName;
    this.sessionId = deps.sessionId;
    this.sink = deps.sink;
    this.injector = deps.injector;
    this.control = deps.control;
    this.deeplinkScheme = deps.deeplinkScheme;
    this.isHumanTyping = deps.isHumanTyping;
    this.mediaDir = deps.mediaDir;
    this.connectionId = deps.connectionId;
    this.startCursor = deps.startCursor;
    this.onRoomChanged = deps.onRoomChanged ?? null;
    this.log = deps.log;
  }

  /** Open the event stream and seed an idle runtime-state report. */
  start(): void {
    this.stream = new SwitchEventStream({
      creds: this.creds,
      connectionId: this.connectionId,
      // One room per session: the connection claims it, which is what stops a
      // second session of the same agent silently competing for the room.
      scope: 'single',
      filter: 'all',
      // Empty until the session connects to one. Declared here only when we
      // already know it — a restored session, or one adopted with a room.
      rooms: this.roomId ? [this.roomId] : [],
      startCursor: this.startCursor,
      onEvent: (event) => this.handleEvent(event),
      onRooms: (rooms) => this.adoptRoom(rooms),
      onGap: (info) => this.handleGap(info),
      onEvicted: (reason) =>
        this.log.warn('RoomConnection: connection evicted', {
          event: 'room_connection_evicted',
          roomId: this.roomId,
          reason,
        }),
      log: this.log,
      signal: this.abort.signal,
    });
    this.stream.start();

    // Seed this room's deeplink right away (an idle report carries it) so the
    // session's `(Open in Switch Console)` link is available in the new room's
    // !status immediately on connect/switch — not only once the agent next
    // works. idle surfaces nothing on the bridge, so this posts no message.
    if (this.roomId) void this.postRuntimeState('idle', null).catch(() => {});
  }

  /**
   * Claim a room we already know about, without waiting to be told.
   *
   * For a **restored** session. Normally the room arrives from the server,
   * because the session's `connect_to_room` claims it on this connection — but
   * a resumed session never calls the tool again: it does not re-run its
   * initial prompt. Nothing is coming, and we are the only ones who remember
   * which room it was in, so we assert it.
   *
   * Not a return to inferring rooms. This is the one case where the knowledge
   * is genuinely ours: read back from our own persisted map for a session we
   * are restarting. Everywhere else the server still decides.
   */
  async repointTo(roomId: string, roomName: string | null): Promise<void> {
    if (this.roomId === roomId) return;
    this.roomName = roomName;
    this.log.debug('RoomConnection: claiming the remembered room for a restored session', {
      event: 'room_connection_repoint',
      sessionId: this.sessionId,
      roomId,
      previous: this.roomId,
    });
    // The server's acknowledgement comes back as `subscription_changed`, which
    // sets `roomId` through the normal path — so there is still exactly one
    // writer for it, and a claim that fails leaves us honestly room-less.
    await this.stream?.repoint(roomId);
  }

  /**
   * Take the room the server says this connection covers.
   *
   * The server is the authority: the session's `connect_to_room` claimed the
   * room on this connection, and this is that fact arriving. Nothing else is
   * allowed to set the room — inferring it anywhere else is what let Switch Console
   * and Switch disagree.
   *
   * A `single`-scope connection covers at most one room, so anything else in
   * the list would be a protocol violation rather than a case to handle.
   */
  private adoptRoom(rooms: string[]): void {
    const next = rooms[0] ?? null;
    // Against what we last *reported*, not what we hold: a session launched
    // into a room declares it at open and the server confirms the same value,
    // which is the only signal the rest of the app ever gets that the session
    // is in that room.
    if (next === this.reportedRoom) return;

    const previous = this.roomId;
    this.roomId = next;
    this.reportedRoom = next;
    // The name is not on the wire — the renderer resolves it from the gateway's
    // room list, and falls back to a short id when it cannot.
    if (next !== previous) this.roomName = null;
    this.log.debug('RoomConnection: room set by the server', {
      event: 'room_connection_room_changed',
      sessionId: this.sessionId,
      previous,
      roomId: next,
    });
    this.onRoomChanged?.(next);
    if (next) void this.postRuntimeState('idle', null).catch(() => {});
  }

  /** Stop the loops and clear any lingering runtime-state surface. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    // Clear any lingering runtime-state surface before aborting (the abort
    // signal would cancel the request, so fire it unsignalled and best-effort).
    // The server's heartbeat-expiry sweep is the backstop if this never lands.
    if (this.runtimeState !== 'idle') {
      this.runtimeState = 'idle';
      this.roomTurnActive = false;
      this.currentThreadId = null;
      this.currentAnchorId = null;
      void this.postRuntimeState('idle', null, { detached: true }).catch(() => {});
    }
    this.abort.abort();
    if (this.busyFallback) clearTimeout(this.busyFallback);
    if (this.humanGateTimer) clearTimeout(this.humanGateTimer);
    this.stopActivityTicker();
  }

  /** The room the session is in, or null until the server has said. */
  get room(): string | null {
    return this.roomId;
  }

  /** The connection this session's tool calls are expected to arrive on. */
  get connection(): string {
    return this.connectionId;
  }

  /**
   * The `<scheme>://session?…` deeplink for this managed session, sent with the
   * runtime-state report so the bridge can link the working / awaiting-input
   * message back to Switch Console. Switch Console owns this link — switch-core relays
   * it verbatim. Resolution is by room, so `server`/`agent` are advisory.
   */
  private sessionDeeplink(): string {
    const params = new URLSearchParams({
      server: this.creds.apiEndpoint,
      agent: this.creds.agentId,
      room: this.roomId ?? '',
      // The shared session id resolves to the exact session on any client
      // (a client that only adopted the session has no room mapping to match on).
      session: this.sessionId,
    });
    return `${this.deeplinkScheme}://session?${params.toString()}`;
  }

  /**
   * `fetch` bounded by a per-request timeout AND aborted when the connection
   * stops. A hang on a half-open socket would otherwise never resolve or reject,
   * wedging whatever loop awaits it; the timeout guarantees the promise settles.
   * The caller may pass an extra signal (e.g. the watchdog's renew controller) to
   * abort a specific in-flight request independently.
   */
  private fetchWithTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    opts: { extraSignal?: AbortSignal; detached?: boolean } = {}
  ): Promise<Response> {
    // `detached` requests (the best-effort final idle report in stop()) are not
    // tied to the connection abort — stop() aborts immediately after firing them,
    // so binding them would cancel the very report they exist to deliver. They
    // are still bounded by the timeout so they can't hang forever.
    const signals = [AbortSignal.timeout(timeoutMs)];
    if (!opts.detached) signals.push(this.abort.signal);
    if (opts.extraSignal) signals.push(opts.extraSignal);
    return fetch(url, { ...init, signal: AbortSignal.any(signals) });
  }

  private async postRuntimeState(
    state: RuntimeState,
    threadId: string | null,
    opts: { detached?: boolean } = {},
    detail?: string | null
  ): Promise<void> {
    this.log.debug('RoomConnection: runtime-state ->', {
      roomId: this.roomId,
      agentId: this.creds.agentId,
      state,
      detail: detail ?? null,
      threadId,
      detached: opts.detached ?? false,
    });
    const resp = await this.fetchWithTimeout(
      `${this.creds.apiEndpoint}/agents/${this.creds.agentId}/runtime-state`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          room_id: this.roomId,
          state,
          thread_id: threadId,
          // Reported on every push, including the periodic activity refresh.
          // The bridge repositions only when the value CHANGES, so a refresh
          // that repeats the current anchor deliberately moves nothing.
          anchor_event_id: this.currentAnchorId,
          deeplink_url: this.sessionDeeplink(),
          detail: detail ?? null,
          control_capabilities: this.control.capabilities,
        }),
      },
      RUNTIME_STATE_REQUEST_TIMEOUT_MS,
      { detached: opts.detached }
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
  }

  /**
   * Handle one event from the stream.
   *
   * Unaddressed room messages are not surfaced; they are tallied and the count
   * is appended to the next event that IS surfaced, so the agent knows it has
   * fallen behind and can catch up with read_context.
   */
  private async handleEvent(event: AgentBridgeEvent): Promise<void> {
    // Session-control commands aren't injected as text — they drive concrete
    // keystrokes (interrupt/compact/reset) against the session.
    if (event.type === 'command') {
      void this.executeCommand(event.payload as CommandPayload);
      return;
    }
    const addressed = event.type === 'message' && (event.payload as MessagePayload).addressed;
    const threadId =
      event.type === 'message' ? ((event.payload as MessagePayload).thread_id ?? null) : null;
    const messageId =
      event.type === 'message' ? (event.payload as MessagePayload).message_id : null;
    if (event.type === 'message' && !addressed) {
      this.missed += 1;
    }
    const text = formatEventForInjection(event, this.roomName);
    this.log.debug('RoomConnection: received event', {
      roomId: this.roomId,
      type: event.type,
      ...(event.type === 'message'
        ? { addressed: (event.payload as MessagePayload).addressed }
        : {}),
      surfaced: text !== null,
    });
    if (!text) return;

    let annotated = text;
    if (event.type === 'message') {
      // Materialise attachments of ANY type to local files and tell the agent
      // they are there — parity with the connector channel. A download that
      // fails is named in the annotation rather than dropped, so the agent is
      // never left believing it saw everything.
      const { imagePaths, filePaths, failed } = await this.downloadAttachments(
        event.payload as MessagePayload
      );
      const annotation = formatAttachmentAnnotation(imagePaths, filePaths, failed);
      if (annotation) {
        annotated = `${annotated}\n${annotation}`;
      }
    }
    let body =
      this.missed > 0
        ? `${annotated}\n(${this.missed} unread room message${this.missed === 1 ? '' : 's'} since your last read_context — call read_context to catch up.)`
        : annotated;
    this.missed = 0;
    if (this.pendingGapReason !== null) {
      body = `${body}\n(Some earlier room events were dropped and cannot be replayed: ${this.pendingGapReason} — call read_context before responding.)`;
      this.pendingGapReason = null;
    }
    this.enqueue({ text: body, addressed, threadId, messageId });
  }

  /**
   * Record that the history has a hole, without waking the session for it.
   *
   * The server reports a gap when it cannot serve our cursor — events aged out
   * of the buffer, or the server restarted and the numbering reset. The session
   * must still learn about it: leaving it believing the stream was complete is
   * the failure mode this transport exists to make impossible. But it learns on
   * the next event we surface, not by being interrupted now — a gap fires on
   * routine reconnects, and each interruption is a whole turn spent on a
   * condition whose only remedy the agent can apply just as well later.
   */
  private handleGap(info: { fromSequence: number; reason: string }): void {
    this.log.warn('RoomConnection: gap — deferring the warning to the next surfaced event', {
      roomId: this.roomId,
      fromSequence: info.fromSequence,
      reason: info.reason,
    });
    this.pendingGapReason = info.reason;
  }

  /**
   * Download a message's attachments — of any type — to local files under
   * `mediaDir`. Mirrors the connector channel: fetch the bytes from the agent
   * bridge (which proxies the Matrix media repo) and write them locally so the
   * agent can Read them.
   *
   * Images and other files are returned separately so the annotation can
   * describe each appropriately. A download that fails returns its filename in
   * `failed` instead of being dropped: it is surfaced to the agent, and it
   * still never throws, so it cannot break event delivery.
   */
  private async downloadAttachments(
    msg: MessagePayload
  ): Promise<{ imagePaths: string[]; filePaths: string[]; failed: string[] }> {
    const attachments = msg.attachments ?? [];
    const imagePaths: string[] = [];
    const filePaths: string[] = [];
    const failed: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      const localPath = await this.fetchAttachmentToFile(att, msg.message_id, i);
      if (!localPath) {
        failed.push(att.filename);
        continue;
      }
      if (att.mimetype.startsWith('image/')) imagePaths.push(localPath);
      else filePaths.push(localPath);
    }
    return { imagePaths, filePaths, failed };
  }

  private async fetchAttachmentToFile(
    att: AttachmentRef,
    messageId: string,
    index: number
  ): Promise<string | null> {
    try {
      const url =
        `${this.creds.apiEndpoint}/agents/${this.creds.agentId}/rooms/${this.roomId}/media` +
        `?mxc=${encodeURIComponent(att.mxc)}`;
      const resp = await this.fetchWithTimeout(
        url,
        { headers: { Authorization: `Bearer ${this.creds.token}` } },
        MEDIA_REQUEST_TIMEOUT_MS
      );
      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
      }
      const bytes = Buffer.from(await resp.arrayBuffer());
      fs.mkdirSync(this.mediaDir, { recursive: true });
      const destName = `${messageId.replace(/[^a-zA-Z0-9]/g, '_')}-${index}-${sanitiseAttachmentName(att.filename)}`;
      const dest = path.join(this.mediaDir, destName);
      fs.writeFileSync(dest, bytes);
      return dest;
    } catch (error) {
      if (this.abort.signal.aborted) return null;
      this.log.warn('RoomConnection: attachment download error', {
        roomId: this.roomId,
        mxc: att.mxc,
        error: String(error),
      });
      return null;
    }
  }

  private enqueue(injection: QueuedInjection): void {
    if (this.stopped) return;
    this.queue.push(injection);
    this.tryFlush();
  }

  /**
   * Update the injection gate when the agent's derived status changes. The
   * caller wires this from the hook server. Only surfaces runtime state to the
   * room while a room-triggered turn is active — local TUI work must not show
   * "working on it" in the bridged channel, nor ping the operator.
   */
  onAgentStatusChange(status: AgentStatus, notificationType?: NotificationType): void {
    if (this.stopped) return;
    if (toRuntimeState(status) === 'awaiting-input') {
      this.log.debug('RoomConnection: status -> awaiting-input', {
        roomId: this.roomId,
        status,
        notificationType,
        roomTurnActive: this.roomTurnActive,
        currentThreadId: this.currentThreadId,
        willSurface: this.roomTurnActive,
      });
    }
    if (this.roomTurnActive) {
      const next = toRuntimeState(status);
      this.setRuntimeState(next);
      if (next === 'idle') {
        this.roomTurnActive = false;
        this.currentThreadId = null;
        this.currentAnchorId = null;
      }
    }
    this.busy = isBlockingStatus(status, notificationType);
    if (!this.busy) this.releaseBusy();
  }

  /**
   * A blocking dialog cleared (or the fallback fired): drop the gate and flush
   * anything that queued while we were blocked.
   */
  private releaseBusy(): void {
    if (this.stopped) return;
    this.busy = false;
    if (this.busyFallback) {
      clearTimeout(this.busyFallback);
      this.busyFallback = null;
    }
    this.tryFlush();
  }

  private setRuntimeState(state: RuntimeState): void {
    // `awaiting-input` always re-surfaces: each report is a fresh request for
    // operator input (Claude emits one per notification, not on a timer), so it
    // must ping again even when the previous state was already awaiting-input —
    // e.g. a follow-up prompt with no intervening `working` event we observed.
    // `working`/`idle` stay deduped: one "working on it…" / one clear is enough.
    if (state !== 'awaiting-input' && this.runtimeState === state) return;
    const wasWorking = this.runtimeState === 'working';
    this.runtimeState = state;
    // A fresh state clears the activity line: a new "working" turn starts from
    // the generic indicator, and idle/awaiting-input carry no activity.
    this.lastActivityDetail = null;
    if (state === 'working') {
      if (!wasWorking) this.workingStartedAt = Date.now();
      this.startActivityTicker();
      // Post the "working on it…" message with an elapsed suffix right away so
      // the timer ticks from the start of the turn, not only once the first
      // activity line arrives.
      this.pushActivity();
      return;
    }
    this.stopActivityTicker();
    void this.postRuntimeState(state, this.currentThreadId).catch((error) => {
      if (this.abort.signal.aborted) return;
      this.log.warn('RoomConnection: failed to set runtime state', {
        roomId: this.roomId,
        state,
        error: String(error),
      });
    });
  }

  /**
   * Refresh the live "working on it…" message with the running turn's latest
   * activity line. Only while a room-triggered turn is actually showing
   * "working" — local TUI work must not surface, and there's no message to edit
   * outside a working turn. Consecutive identical lines are skipped.
   */
  reportActivity(detail: string): void {
    if (this.stopped) return;
    if (!this.roomTurnActive || this.runtimeState !== 'working') return;
    const trimmed = detail.trim();
    if (!trimmed || trimmed === this.lastActivityDetail) return;
    this.lastActivityDetail = trimmed;
    this.pushActivity();
  }

  /** Compose the activity line with a live elapsed suffix, e.g. "…foo.py · 15s".
   * Before any per-turn activity is reported, falls back to the generic
   * "working on it…" phrase so the elapsed timer still ticks from the start of
   * the turn. */
  private composeActivityDetail(): string {
    const base = this.lastActivityDetail ?? '_Working on it…_';
    const elapsed = formatElapsed(Date.now() - this.workingStartedAt);
    return elapsed ? `${base} · ${elapsed}` : base;
  }

  /** Push the current activity line (base + elapsed) to the bridge. */
  private pushActivity(): void {
    const detail = this.composeActivityDetail();
    void this.postRuntimeState('working', this.currentThreadId, {}, detail).catch((error) => {
      if (this.abort.signal.aborted) return;
      this.log.warn('RoomConnection: failed to report activity', {
        roomId: this.roomId,
        error: String(error),
      });
    });
  }

  private startActivityTicker(): void {
    this.stopActivityTicker();
    this.activityTicker = setInterval(() => {
      if (this.stopped || !this.roomTurnActive || this.runtimeState !== 'working') {
        this.stopActivityTicker();
        return;
      }
      this.pushActivity();
    }, ACTIVITY_TICK_INTERVAL_MS);
  }

  private stopActivityTicker(): void {
    if (this.activityTicker) {
      clearInterval(this.activityTicker);
      this.activityTicker = null;
    }
  }

  private tryFlush(): void {
    if (this.stopped || this.queue.length === 0) return;

    if (this.busy) {
      // Blocked on a permission/elicitation dialog; the message stays queued and
      // is retried when the dialog clears (releaseBusy) or the fallback fires.
      // Arm the fallback so a dialog that never reports resolution can't wedge
      // the queue. Log so an undelivered message is visible, not silent.
      this.log.debug('RoomConnection: injection deferred — blocked on dialog', {
        roomId: this.roomId,
        queued: this.queue.length,
      });
      if (!this.busyFallback) {
        this.busyFallback = setTimeout(() => this.releaseBusy(), BUSY_FALLBACK_MS);
      }
      return;
    }

    if (this.isHumanTyping()) {
      // The operator is typing into the pane; injecting now would interleave the
      // message and its trailing Enter with their keystrokes. Re-check shortly —
      // delivery resumes as soon as they pause.
      this.log.debug('RoomConnection: injection deferred — operator typing', {
        roomId: this.roomId,
        queued: this.queue.length,
      });
      if (!this.humanGateTimer) {
        this.humanGateTimer = setTimeout(() => {
          this.humanGateTimer = null;
          this.tryFlush();
        }, HUMAN_GATE_RETRY_MS);
      }
      return;
    }

    const target = this.sink.acquire();
    if (!target) {
      // Target not live yet (or already gone); leave the message queued and
      // retry on the next status change or poll event.
      this.log.warn('RoomConnection: injection deferred — no live target for session', {
        roomId: this.roomId,
        queued: this.queue.length,
      });
      return;
    }

    const item = this.queue.shift()!;
    const { payload, submitSequence, submitDelayMs } = this.injector.build(item.text);

    try {
      // Always write the submit keystroke separately, after the text has been
      // delivered. Writing both in one chunk makes TUIs (Claude) treat the
      // trailing Enter as part of the pasted input, leaving the text unsent.
      target.write(payload);
      this.log.debug('RoomConnection: injected message into target', {
        roomId: this.roomId,
        addressed: item.addressed,
        queued: this.queue.length,
      });
      setTimeout(() => {
        try {
          target.write(submitSequence);
        } catch (error) {
          this.log.warn('RoomConnection: failed to submit injected message', {
            roomId: this.roomId,
            error: String(error),
          });
        }
      }, submitDelayMs);
    } catch (error) {
      this.log.warn('RoomConnection: failed to inject message', {
        roomId: this.roomId,
        error: String(error),
      });
      // Put it back so it is not lost.
      this.queue.unshift(item);
      return;
    }

    // An addressed message kicks off a room turn — open the gate so runtime
    // state surfaces to the room (in the triggering message's thread, if any)
    // and show "working" immediately; status changes reconcile it from there.
    if (item.addressed) {
      this.roomTurnActive = true;
      this.currentThreadId = item.threadId;
      this.currentAnchorId = item.messageId;
      this.setRuntimeState('working');
    }

    // We do NOT gate after injecting: Claude queues input typed while it works,
    // so a follow-up injects right away. If more messages queued while we were
    // blocked, drain them sequentially — spaced past the delayed submit so the
    // writes don't interleave into one garbled prompt.
    if (this.queue.length > 0) {
      setTimeout(() => this.tryFlush(), submitDelayMs + 50);
    }
  }

  /**
   * Execute a queued session-control command (interrupt / compact / reset) by
   * driving its provider-specific keystroke plan against the sink. Unlike
   * message injection this is not gated on human-typing: control commands are
   * explicit operator/room actions (an interrupt in particular must land
   * promptly). Steps run sequentially, spaced so a TUI doesn't merge them —
   * e.g. reset's `/clear` must settle before the reconnect prompt is typed.
   */
  private async executeCommand(payload: CommandPayload): Promise<void> {
    const command = payload.command;
    if (!this.roomId) {
      // A control command can only have come from a room, so this means the
      // server told us about the event before it told us about the room.
      // Refusing beats guessing: `reset` re-types a connect prompt naming the
      // room, and naming the wrong one would move the session.
      this.log.warn('RoomConnection: control command before the room is known', {
        event: 'room_connection_command_without_room',
        sessionId: this.sessionId,
        command,
      });
      return;
    }
    const plan = this.control.plan(command, {
      room: this.roomName ?? this.roomId,
      role: payload.args || null,
      threadId: payload.thread_id ?? null,
      user: payload.user_name || null,
    });
    if (!plan) {
      this.log.warn('RoomConnection: unsupported control command ignored', {
        roomId: this.roomId,
        command,
      });
      return;
    }

    const target = this.sink.acquire();
    if (!target) {
      this.log.warn('RoomConnection: control command dropped — no live target', {
        roomId: this.roomId,
        command,
      });
      return;
    }

    this.log.debug('RoomConnection: executing control command', {
      roomId: this.roomId,
      command,
      steps: plan.length,
    });

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
    for (const action of plan) {
      try {
        if (action.kind === 'raw') {
          target.write(action.data);
        } else {
          const { payload: text, submitSequence, submitDelayMs } = this.injector.build(action.text);
          target.write(text);
          await wait(submitDelayMs);
          target.write(submitSequence);
        }
      } catch (error) {
        this.log.warn('RoomConnection: control command step failed', {
          roomId: this.roomId,
          command,
          error: String(error),
        });
        return;
      }
      await wait(CONTROL_STEP_GAP_MS);
    }
  }
}
