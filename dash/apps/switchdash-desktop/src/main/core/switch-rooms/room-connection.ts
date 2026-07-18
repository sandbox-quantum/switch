import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentStatus, NotificationType } from '@shared/core/providers/agentEvents';
import type { InjectionSink } from './injection-sink';
import type { SessionControl } from './session-control';
import {
  formatEventForInjection,
  formatImageAttachmentAnnotation,
  type AgentBridgeEventResponse,
  type AttachmentRef,
  type CommandPayload,
  type MessagePayload,
} from './switch-event-format';

const POLL_TIMEOUT_S = 10;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// Per-request timeouts. Without these a fetch on a half-open socket (e.g. during
// a brief ALB 5xx blip) can hang forever with no response and no error, wedging
// the await-each-tick loop it runs in — the renew loop in particular, which then
// stops refreshing liveness so the session ages out (SESSION_TTL) and the agent
// silently drops the room. Every fetch is bounded so a hang aborts and the
// surrounding backoff loop continues.
//
// The long-poll waits up to POLL_TIMEOUT_S server-side, so its client bound adds
// slack on top. Renew is deliberately short — shorter than the server's ~6s
// SESSION_TTL — so a hung renew aborts and retries well inside the window that
// would otherwise drop the session.
const POLL_REQUEST_TIMEOUT_MS = POLL_TIMEOUT_S * 1000 + 5_000;
const RENEW_REQUEST_TIMEOUT_MS = 4_000;
const RUNTIME_STATE_REQUEST_TIMEOUT_MS = 10_000;
const MEDIA_REQUEST_TIMEOUT_MS = 30_000;
// Watchdog cadence + staleness bound for the renew loop. If no renew has
// succeeded within the threshold the loop is presumed wedged (a request stalled
// past its own timeout, or the loop otherwise stopped making progress): abort the
// in-flight renew to force an immediate fresh attempt, and warn loudly so a
// silently-dropped room is visible rather than mysterious.
const RENEW_WATCHDOG_INTERVAL_MS = 2_000;
const RENEW_STALE_THRESHOLD_MS = 8_000;
// Safety net for the dialog gate: if a blocking prompt (permission/elicitation)
// never reports resolution, release the gate after this long so queued messages
// can't get permanently stuck. Normal turns are never gated.
const BUSY_FALLBACK_MS = 60_000;
// Cadence for the room connection-liveness heartbeat. The server keeps the
// agent's session "connected" only while these renews arrive (SESSION_TTL), so
// a closed session drops to "no session" within seconds. Mirrors the connector
// channel's CONNECTION_RENEW_INTERVAL_MS.
const CONNECTION_RENEW_INTERVAL_MS = 2000;
// Cadence for the role-lease heartbeat. When the managed session assumes a room
// role, the server holds the seat only while `/leases/renew` arrives within its
// LEASE_TTL (~6s), so without this a role assumed from switchdash auto-releases
// within seconds. Renewed unconditionally: the server's touch is room-agnostic
// and a no-op when no lease is held, so it keeps a held role alive and does
// nothing otherwise. Mirrors the connector channel's LEASE_RENEW_INTERVAL_MS.
const LEASE_RENEW_INTERVAL_MS = 2000;
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
 * per-conversation `AgentStatus` is collapsed onto these before reporting:
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
   * conversation root.
   */
  threadId: string | null;
}

/** Provider-specific keystroke payload builder, injected to keep the core free
 * of the plugin registry (which is unavailable in the remote sidecar). */
export interface PromptInjector {
  build(text: string): { payload: string; submitSequence: string; submitDelayMs: number };
}

export interface RoomConnectionLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface RoomConnectionDeps {
  creds: SwitchCredentials;
  roomId: string;
  roomName: string | null;
  /** The switchdash session id of the session this connection drives, so
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
   * environment supplies its own (a switchdash temp dir locally, a VM-local
   * temp dir in the sidecar).
   */
  mediaDir: string;
  log: RoomConnectionLogger;
}

/**
 * One agent ↔ one Switch room: long-polls the agent bridge for room events,
 * injects addressed messages / task events into the session via an
 * `InjectionSink`, keeps the room connection alive with a renew heartbeat, and
 * reports runtime state back to the bridge. Transport-agnostic — the local main
 * process drives it with a PTY-backed sink, the remote sidecar with a
 * tmux-backed one.
 */
export class RoomConnection {
  private readonly creds: SwitchCredentials;
  private readonly roomId: string;
  private readonly roomName: string | null;
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
  /** Last activity line (without the elapsed suffix), to skip redundant refreshes. */
  private lastActivityDetail: string | null = null;
  /** Monotonic timestamp the current working turn began, for the elapsed suffix. */
  private workingStartedAt = 0;
  /** Ticker that re-pushes the activity line with a refreshed elapsed suffix. */
  private activityTicker: ReturnType<typeof setInterval> | null = null;
  private busyFallback: ReturnType<typeof setTimeout> | null = null;
  private humanGateTimer: ReturnType<typeof setTimeout> | null = null;
  /** Monotonic timestamp of the last renew that succeeded — drives the watchdog. */
  private lastRenewOkAt = 0;
  /** Aborts just the in-flight renew request (independent of the loop's own
   * per-request timeout) so the watchdog can force an immediate retry. */
  private renewRequestAbort: AbortController | null = null;
  private renewWatchdog: ReturnType<typeof setInterval> | null = null;

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
    this.log = deps.log;
  }

  /** Begin polling + renew loops and seed an idle runtime-state report. */
  start(): void {
    void this.pollLoop();
    void this.connectionRenewLoop();
    void this.leaseRenewLoop();
    this.renewWatchdog = setInterval(() => this.checkRenewStale(), RENEW_WATCHDOG_INTERVAL_MS);

    // Seed this room's deeplink right away (an idle report carries it) so the
    // session's `(Open in SwitchDash)` link is available in the new room's
    // !status immediately on connect/switch — not only once the agent next
    // works. idle surfaces nothing on the bridge, so this posts no message.
    void this.postRuntimeState('idle', null).catch(() => {});
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
      void this.postRuntimeState('idle', null, { detached: true }).catch(() => {});
    }
    this.abort.abort();
    if (this.busyFallback) clearTimeout(this.busyFallback);
    if (this.humanGateTimer) clearTimeout(this.humanGateTimer);
    if (this.renewWatchdog) clearInterval(this.renewWatchdog);
    this.stopActivityTicker();
  }

  get room(): string {
    return this.roomId;
  }

  /**
   * The `<scheme>://session?…` deeplink for this managed session, sent with the
   * runtime-state report so the bridge can link the working / awaiting-input
   * message back to switchdash. switchdash owns this link — switch-core relays
   * it verbatim. Resolution is by room, so `server`/`agent` are advisory.
   */
  private sessionDeeplink(): string {
    const params = new URLSearchParams({
      server: this.creds.apiEndpoint,
      agent: this.creds.agentId,
      room: this.roomId,
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

  /** Refresh the room connection-liveness heartbeat. Throws on a non-OK response. */
  private async postConnectionRenew(requestAbort: AbortController): Promise<void> {
    const resp = await this.fetchWithTimeout(
      `${this.creds.apiEndpoint}/agents/${this.creds.agentId}/connection/renew`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.creds.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ room_id: this.roomId }),
      },
      RENEW_REQUEST_TIMEOUT_MS,
      { extraSignal: requestAbort.signal }
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
  }

  /** Refresh the role-lease heartbeat. Throws on a non-OK response. */
  private async postLeaseRenew(): Promise<void> {
    const resp = await this.fetchWithTimeout(
      `${this.creds.apiEndpoint}/agents/${this.creds.agentId}/leases/renew`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.creds.token}`,
          'Content-Type': 'application/json',
        },
      },
      RENEW_REQUEST_TIMEOUT_MS
    );
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    }
  }

  /**
   * Keep the agent's session marked "connected" to the room while we poll it.
   * The connect_to_room hook only fires on a live tool call, so after a restart
   * (or whenever switchdash owns the session) nothing else renews this — without
   * it the bridge would consider the session gone within seconds.
   *
   * Each renew is bounded by RENEW_REQUEST_TIMEOUT_MS (see fetchWithTimeout) so a
   * hung request can never wedge this loop, and a watchdog re-aborts an in-flight
   * renew that has stalled the loop past RENEW_STALE_THRESHOLD_MS. `renew` is an
   * upsert server-side, so once requests flow again a TTL-expired session
   * re-establishes on the next success — no explicit re-connect needed.
   */
  private async connectionRenewLoop(): Promise<void> {
    // Seed the watchdog clock so a wedge before the first success is still caught.
    this.lastRenewOkAt = Date.now();
    while (!this.abort.signal.aborted) {
      const requestAbort = new AbortController();
      this.renewRequestAbort = requestAbort;
      try {
        await this.postConnectionRenew(requestAbort);
        this.lastRenewOkAt = Date.now();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.log.warn('RoomConnection: connection renew error', {
          roomId: this.roomId,
          error: String(error),
        });
      } finally {
        if (this.renewRequestAbort === requestAbort) this.renewRequestAbort = null;
      }
      await new Promise((r) => setTimeout(r, CONNECTION_RENEW_INTERVAL_MS));
    }
  }

  /**
   * Keep any role the managed session has assumed alive. The server holds the
   * seat only while `/leases/renew` arrives within its LEASE_TTL, and the
   * `connect_to_room`/`assume_role` hooks fire only on the agent's own tool
   * calls — nothing else renews the lease when switchdash owns the session, so
   * without this a role assumed from switchdash auto-releases within seconds.
   *
   * Renewed unconditionally: `touch_lease` is room-agnostic and a no-op when no
   * lease is held, so this keeps a held role alive and does nothing otherwise.
   * Each renew is bounded by RENEW_REQUEST_TIMEOUT_MS so a hung request cannot
   * wedge the loop; the loop ends on abort, which lets the lease expire and the
   * role auto-release shortly after the connection stops.
   */
  private async leaseRenewLoop(): Promise<void> {
    while (!this.abort.signal.aborted) {
      try {
        await this.postLeaseRenew();
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.log.warn('RoomConnection: lease renew error', {
          roomId: this.roomId,
          error: String(error),
        });
      }
      await new Promise((r) => setTimeout(r, LEASE_RENEW_INTERVAL_MS));
    }
  }

  /**
   * Detect a renew loop that has stopped making progress — no successful renew
   * within RENEW_STALE_THRESHOLD_MS. Abort the in-flight request so the loop
   * retries immediately instead of waiting out a stall, and warn loudly: a
   * silently-dropped room should be visible, not mysterious.
   */
  private checkRenewStale(): void {
    if (this.abort.signal.aborted) return;
    const staleMs = Date.now() - this.lastRenewOkAt;
    if (staleMs <= RENEW_STALE_THRESHOLD_MS) return;
    this.log.warn('RoomConnection: renew stale — forcing retry', {
      roomId: this.roomId,
      staleMs,
    });
    this.renewRequestAbort?.abort();
  }

  private async pollLoop(): Promise<void> {
    let backoff = INITIAL_BACKOFF_MS;
    const url = `${this.creds.apiEndpoint}/agents/${this.creds.agentId}/rooms/${this.roomId}/events?timeout=${POLL_TIMEOUT_S}`;
    // Tally unaddressed room messages filtered out since the last event we DID
    // surface, and annotate the next surfaced event with the count — mirroring
    // the channel's missed_count so the agent knows it has fallen behind.
    let missed = 0;

    while (!this.abort.signal.aborted) {
      try {
        const resp = await this.fetchWithTimeout(
          url,
          { headers: { Authorization: `Bearer ${this.creds.token}` } },
          POLL_REQUEST_TIMEOUT_MS
        );

        if (resp.status === 204) {
          backoff = INITIAL_BACKOFF_MS;
          continue;
        }
        if (!resp.ok) {
          throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
        }

        backoff = INITIAL_BACKOFF_MS;
        const data = (await resp.json()) as AgentBridgeEventResponse;
        for (const event of data.events) {
          // Session-control commands aren't injected as text — they drive
          // concrete keystrokes (interrupt/compact/reset) against the session.
          if (event.type === 'command') {
            void this.executeCommand(event.payload as CommandPayload);
            continue;
          }
          const addressed = event.type === 'message' && (event.payload as MessagePayload).addressed;
          const threadId =
            event.type === 'message' ? ((event.payload as MessagePayload).thread_id ?? null) : null;
          if (event.type === 'message' && !addressed) {
            missed += 1;
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
          if (text) {
            let annotated = text;
            if (event.type === 'message') {
              // Materialise image attachments to local files and tell the agent
              // they are there — parity with the connector channel, which the
              // pollers otherwise lacked. Best-effort: a failed download is
              // logged and omitted, never blocking the message.
              const imagePaths = await this.downloadImageAttachments(
                event.payload as MessagePayload
              );
              if (imagePaths.length > 0) {
                annotated = `${annotated}\n${formatImageAttachmentAnnotation(imagePaths)}`;
              }
            }
            const body =
              missed > 0
                ? `${annotated}\n(${missed} unread room message${missed === 1 ? '' : 's'} since your last read_context — call read_context to catch up.)`
                : annotated;
            missed = 0;
            this.enqueue({ text: body, addressed, threadId });
          }
        }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        this.log.warn('RoomConnection: poll error', {
          roomId: this.roomId,
          error: String(error),
        });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Download a message's image attachments to local files under `mediaDir`,
   * returning their paths. Mirrors the connector channel: filter by an
   * `image/*` mimetype, fetch the bytes from the agent bridge (which proxies
   * the Matrix media repo), and write them locally so the agent can Read them.
   * Best-effort — a failed download is logged and skipped, never thrown, so it
   * cannot break event delivery.
   */
  private async downloadImageAttachments(msg: MessagePayload): Promise<string[]> {
    const attachments = msg.attachments ?? [];
    const paths: string[] = [];
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (!att.mimetype.startsWith('image/')) continue;
      const localPath = await this.fetchAttachmentToFile(att, msg.message_id, i);
      if (localPath) paths.push(localPath);
    }
    return paths;
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
