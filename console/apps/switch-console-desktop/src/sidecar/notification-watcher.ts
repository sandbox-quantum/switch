import { randomUUID } from 'node:crypto';
import { type AgentBridgeEvent, SwitchEventStream } from '@sandboxaq/switch-agent-runtime';
import type { SwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';

// How often the auto_session gate is re-read, so toggling it takes effect
// without restarting the sidecar. Matches the cadence the old idle loop woke
// at, so enabling auto_session still takes effect within about a second rather
// than becoming noticeably laggier. The connection's own heartbeat runs at the
// protocol's 2s cadence inside SwitchEventStream; this only decides whether
// that connection should exist at all.
const GATE_POLL_INTERVAL_MS = 1_000;
const SPAWN_MAX_ATTEMPTS = 3;
const SPAWN_RETRY_DELAY_MS = 2000;
// How long a room stays "spawn in flight" before the guard is cleared.
//
// This covers the window the server cannot: it learns a session exists only
// when that session's connection claims the room, tens of seconds after the
// process starts. Until then the room looks unattended and every further
// addressed message would spawn again. Cleared early once the session is live;
// this TTL is the backstop for a spawn that failed.
const INFLIGHT_TTL_MS = 120_000;

export interface WatcherLogger {
  debug(...input: unknown[]): void;
  info(...input: unknown[]): void;
  warn(...input: unknown[]): void;
  error(...input: unknown[]): void;
}

/** Sleep that resolves early when the signal aborts, so stop() ends loops promptly. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Launches (and reports on) fresh agent sessions on the VM. The watcher owns
 * the poll loop, heartbeat, in-flight guard and retry policy; the spawner just
 * performs one launch attempt and reports whether a room already has a live
 * session.
 */
export interface SessionSpawner {
  /** True when a session this watcher started is already attending the room. */
  isRoomLive(roomId: string): Promise<boolean>;
  /**
   * Launch one fresh session bound to the room. Throws on failure so the
   * watcher can retry.
   *
   * `startCursor` is where the new session's own connection should begin
   * reading. The watcher has already consumed the triggering event — that is
   * how it knows to spawn — so a session opening at head comes up having
   * missed the very message it exists to answer.
   */
  launch(roomId: string, requesterName: string | null, startCursor?: number): Promise<void>;
}

/**
 * The name of whoever addressed the agent, so a notice can reach them rather
 * than just appear in the channel. Null for a command or a join, which nobody
 * is waiting on an answer to.
 */
export function requesterNameOf(event: AgentBridgeEvent): string | null {
  if (event.type !== 'message') return null;
  const name = (event.payload as { sender_name?: string }).sender_name;
  return name?.trim() ? name.trim() : null;
}

/**
 * Address a room notice to the person waiting on it.
 *
 * The `@name` is deliberate: Switch re-parses it, so the notice reaches them
 * wherever they are instead of scrolling past in a channel they may not be
 * looking at. That is the whole point of a notice saying nobody is coming.
 */
export function addressedTo(requesterName: string | null, body: string): string {
  return requesterName ? `${body} (FYI @${requesterName})` : body;
}

/**
 * What the room is told when a session never came up.
 *
 * Says only why, and carries no link: the "Open in Switch Console" link and the
 * mention of the agent's owner come from the session's runtime state, which
 * switch-core renders into a clickable line. A `switchdash://` URL written into
 * a message body is never rewritten and arrives as dead text.
 */
export const STARTUP_STALL_NOTICE =
  'My session seems to be blocked on something and never started — most likely a prompt only a human can answer.';

/**
 * Post a message to a room on the agent's behalf. Throws on non-OK.
 *
 * Used for the two notices this VM owes a room it cannot serve: a spawn that
 * failed outright, and one that succeeded into a session which never started.
 */
export async function postRoomMessage(
  creds: SwitchAgentCredentials,
  roomId: string,
  content: string
): Promise<void> {
  const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/message`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ room_id: roomId, content }),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}

/**
 * The VM-side port of Switch Console's `AutoSessionWatcher`: long-polls the Switch
 * agent-bridge notification stream and, whenever the agent is addressed in a
 * room where it has no live session, spawns a fresh session (connected to the
 * room and ready to receive the waiting message) — without Switch Console running.
 *
 * The triggering message is delivered by the spawned session's own per-room
 * poller once it connects; the notification stream is a separate queue, so the
 * event still waits in the room's event queue. A single agent-level long-poll
 * is multiplexed across all the agent's rooms, plus the global "watching"
 * heartbeat that keeps the server replying "Starting a session…" while dormant.
 */
export class NotificationWatcher {
  private readonly abort = new AbortController();
  /** Room ids with a spawn in flight (booting / connecting) → guards against
   * duplicate spawns while a notification storm lands during the boot window. */
  private readonly inFlight = new Map<string, ReturnType<typeof setTimeout>>();
  /** Chosen once so the connection survives a dropped socket. */
  private readonly connectionId = randomUUID();
  /** Aborts the watch connection when auto_session is toggled off. */
  private streamAbort: AbortController | null = null;

  constructor(
    private readonly deps: {
      creds: SwitchAgentCredentials;
      spawner: SessionSpawner;
      /**
       * Live gate: the sidecar always serves session injection, but only
       * auto-starts sessions (and keeps the DORMANT-reply heartbeat alive) when
       * the agent has auto_session enabled. Read fresh each loop so toggling
       * auto_session takes effect without restarting the sidecar.
       */
      watchEnabled: () => boolean;
      log: WatcherLogger;
    }
  ) {}

  start(): void {
    const { creds, log } = this.deps;
    log.info('NotificationWatcher: started', { agentId: creds.agentId });
    void this.gateLoop();
  }

  stop(): void {
    this.abort.abort();
    this.closeStream();
    for (const timer of this.inFlight.values()) clearTimeout(timer);
    this.inFlight.clear();
    this.deps.log.info('NotificationWatcher: stopped');
  }

  /**
   * Hold the watch connection open exactly while auto_session is enabled.
   *
   * The connection carries both jobs the two old loops did: it delivers the
   * addressed events that trigger a spawn, and its heartbeat is what makes the
   * agent report DORMANT so the server answers "Starting a session…". Tying
   * both to the gate keeps that promise honest — a sidecar that will not start
   * a session should not be advertising that it will.
   */
  private async gateLoop(): Promise<void> {
    const { watchEnabled } = this.deps;
    const { signal } = this.abort;
    while (!signal.aborted) {
      if (watchEnabled()) this.openStream();
      else this.closeStream();
      await sleep(GATE_POLL_INTERVAL_MS, signal);
    }
  }

  private openStream(): void {
    if (this.streamAbort) return;
    const { creds, log } = this.deps;
    const streamAbort = new AbortController();
    this.streamAbort = streamAbort;
    log.info('NotificationWatcher: opening watch connection', {
      agentId: creds.agentId,
      connectionId: this.connectionId,
    });
    new SwitchEventStream({
      creds: { agentId: creds.agentId, apiEndpoint: creds.apiEndpoint, token: creds.token },
      connectionId: this.connectionId,
      // Every room the agent belongs to except those a session's connection has
      // claimed — the server, not this process, decides which those are.
      scope: 'all',
      filter: 'addressed',
      rooms: [],
      // Same promise as Switch Console's watcher: this process will spawn.
      spawnCapable: true,
      onEvent: (event) => {
        if (event.room_id) {
          this.handleNotification(event.room_id, requesterNameOf(event), event.sequence);
        }
      },
      onGap: (info) => {
        log.warn('NotificationWatcher: gap — may have missed a spawn trigger', {
          agentId: creds.agentId,
          fromSequence: info.fromSequence,
          reason: info.reason,
        });
      },
      onEvicted: (reason) => {
        log.warn('NotificationWatcher: watch connection evicted', {
          agentId: creds.agentId,
          reason,
        });
      },
      log: {
        debug: (message, meta) => log.debug(message, meta),
        warn: (message, meta) => log.warn(message, meta),
        error: (message, meta) => log.warn(message, meta),
      },
      signal: AbortSignal.any([streamAbort.signal, this.abort.signal]),
    }).start();
  }

  private closeStream(): void {
    if (!this.streamAbort) return;
    this.streamAbort.abort();
    this.streamAbort = null;
    this.deps.log.info('NotificationWatcher: watch connection closed (auto_session off)');
  }

  /** Decide whether to spawn for a notified room, with a per-room in-flight guard. */
  private handleNotification(
    roomId: string,
    requesterName: string | null,
    sequence?: number
  ): void {
    if (this.inFlight.has(roomId)) {
      this.deps.log.info(
        'NotificationWatcher: notification for room with a spawn already in flight — skipping duplicate spawn',
        { roomId }
      );
      return;
    }

    const timer = setTimeout(() => this.inFlight.delete(roomId), INFLIGHT_TTL_MS);
    this.inFlight.set(roomId, timer);

    // One before the trigger, so the session's stream replays it. Overlapping
    // by an event is cheap — a connection only receives events for the room it
    // claims — where a gap is the bug this exists to prevent.
    const startCursor = sequence === undefined ? undefined : Math.max(sequence - 1, 0);

    void this.spawnForRoom(roomId, requesterName, startCursor).catch((error) => {
      this.deps.log.warn('NotificationWatcher: spawn failed', { roomId, error: String(error) });
    });
  }

  /**
   * Clear the in-flight guard for a room, so the next notification spawns a fresh
   * session immediately. Called when a session actually connects to the room (the
   * live-room check takes over the guard from here — mirrors the local
   * AutoSessionWatcher) and when a session is deleted before it ever connected.
   */
  clearRoom(roomId: string): void {
    this.clearInFlight(roomId);
  }

  private async spawnForRoom(
    roomId: string,
    requesterName: string | null,
    startCursor?: number
  ): Promise<void> {
    const { spawner, creds, log } = this.deps;

    // A session this watcher started is already attending the room — its own
    // per-room poller delivers the message; nothing to do.
    if (await spawner.isRoomLive(roomId)) {
      this.clearInFlight(roomId);
      return;
    }

    let lastError: string | null = null;
    for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt += 1) {
      if (this.abort.signal.aborted) return;
      try {
        await spawner.launch(roomId, requesterName, startCursor);
        // Half of a hand-off logged at both ends, so a session that comes up
        // without its triggering message can be diagnosed from the log alone:
        // this says where the session should start reading, and the runtime's
        // `switch_session_connection_open` says where it actually started.
        log.info('NotificationWatcher: spawned session for room', {
          event: 'auto_session_spawned',
          agentId: creds.agentId,
          roomId,
          startFrom: startCursor ?? 'head',
        });
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt < SPAWN_MAX_ATTEMPTS) {
        await sleep(SPAWN_RETRY_DELAY_MS, this.abort.signal);
      }
    }

    // Bounded retries exhausted — be honest in the room rather than leaving the
    // human hanging on the backend's "Starting a session…" promise. Clear the
    // in-flight guard so a later notification can try again.
    this.clearInFlight(roomId);
    log.error('NotificationWatcher: could not spawn session after retries', {
      agentId: creds.agentId,
      roomId,
      error: lastError,
    });
    await postRoomMessage(
      creds,
      roomId,
      addressedTo(
        requesterName,
        "I tried to start a session to handle this but couldn't — my operator may need to start one manually."
      )
    ).catch((error) => {
      log.warn('NotificationWatcher: failed to post spawn-failure notice', {
        roomId,
        error: String(error),
      });
    });
  }

  private clearInFlight(roomId: string): void {
    const timer = this.inFlight.get(roomId);
    if (timer) clearTimeout(timer);
    this.inFlight.delete(roomId);
  }
}
