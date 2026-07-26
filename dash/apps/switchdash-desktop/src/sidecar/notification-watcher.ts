import type { SwitchAgentCredentials } from '@main/core/switch-rooms/switch-credentials';
import type { AgentBridgeEventResponse } from '@main/core/switch-rooms/switch-event-format';

const NOTIF_POLL_TIMEOUT_S = 10;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;
// Refresh the "watching" heartbeat well under the server's ALWAYS_ON_TTL (90s)
// so a dormant agent reports DORMANT (and the server replies "Starting a
// session…") while the sidecar is watching on the VM.
const WATCH_HEARTBEAT_INTERVAL_MS = 30_000;
const SPAWN_MAX_ATTEMPTS = 3;
const SPAWN_RETRY_DELAY_MS = 2000;
// How long a room stays "spawn in flight" before the guard is cleared. Covers
// the boot+connect window; once the spawned tmux session is live, the
// live-session check no-ops further notifications anyway. If the spawn failed,
// clearing lets the next notification retry.
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
  /** Launch one fresh session bound to the room. Throws on failure so the watcher can retry. */
  launch(roomId: string): Promise<void>;
}

/** Post a message to a room on the agent's behalf (the spawn-failure notice). Throws on non-OK. */
async function postRoomMessage(
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

/** Refresh the agent's "watching" heartbeat. Throws on non-OK. */
async function postWatchHeartbeat(
  creds: SwitchAgentCredentials,
  signal: AbortSignal
): Promise<void> {
  const resp = await fetch(`${creds.apiEndpoint}/agents/${creds.agentId}/watch/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    signal,
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}

/**
 * The VM-side port of switchdash's `AutoSessionWatcher`: long-polls the Switch
 * agent-bridge notification stream and, whenever the agent is addressed in a
 * room where it has no live session, spawns a fresh session (connected to the
 * room and ready to receive the waiting message) — without switchdash running.
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
    void this.notificationLoop();
    void this.watchHeartbeatLoop();
  }

  stop(): void {
    this.abort.abort();
    for (const timer of this.inFlight.values()) clearTimeout(timer);
    this.inFlight.clear();
    this.deps.log.info('NotificationWatcher: stopped');
  }

  private async watchHeartbeatLoop(): Promise<void> {
    const { creds, watchEnabled, log } = this.deps;
    const { signal } = this.abort;
    while (!signal.aborted) {
      if (!watchEnabled()) {
        await sleep(WATCH_HEARTBEAT_INTERVAL_MS, signal);
        continue;
      }
      try {
        await postWatchHeartbeat(creds, signal);
      } catch (error) {
        if (signal.aborted) return;
        log.warn('NotificationWatcher: watch heartbeat error', {
          agentId: creds.agentId,
          error: String(error),
        });
      }
      await sleep(WATCH_HEARTBEAT_INTERVAL_MS, signal);
    }
  }

  private async notificationLoop(): Promise<void> {
    const { creds, watchEnabled, log } = this.deps;
    const { signal } = this.abort;
    const url = `${creds.apiEndpoint}/agents/${creds.agentId}/notifications?timeout=${NOTIF_POLL_TIMEOUT_S}`;
    let backoff = INITIAL_BACKOFF_MS;
    log.debug('NotificationWatcher: notification loop started', { agentId: creds.agentId, url });

    while (!signal.aborted) {
      // Auto_session disabled → do not poll (the stream is a destructive queue,
      // so draining it while we won't act would swallow events). Idle instead.
      if (!watchEnabled()) {
        await sleep(INITIAL_BACKOFF_MS, signal);
        continue;
      }
      try {
        const resp = await fetch(url, {
          headers: { Authorization: `Bearer ${creds.token}` },
          signal,
        });
        if (resp.status === 204) {
          backoff = INITIAL_BACKOFF_MS;
          continue;
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);

        backoff = INITIAL_BACKOFF_MS;
        const data = (await resp.json()) as AgentBridgeEventResponse;
        for (const event of data.events) {
          this.handleNotification(event.room_id);
        }
      } catch (error) {
        if (signal.aborted) return;
        log.warn('NotificationWatcher: notification poll error', {
          agentId: creds.agentId,
          error: String(error),
        });
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /** Decide whether to spawn for a notified room, with a per-room in-flight guard. */
  private handleNotification(roomId: string): void {
    if (this.inFlight.has(roomId)) {
      this.deps.log.info(
        'NotificationWatcher: notification for room with a spawn already in flight — skipping duplicate spawn',
        { roomId }
      );
      return;
    }

    const timer = setTimeout(() => this.inFlight.delete(roomId), INFLIGHT_TTL_MS);
    this.inFlight.set(roomId, timer);

    void this.spawnForRoom(roomId).catch((error) => {
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

  private async spawnForRoom(roomId: string): Promise<void> {
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
        await spawner.launch(roomId);
        log.info('NotificationWatcher: spawned session for room', {
          agentId: creds.agentId,
          roomId,
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
      "I tried to start a session to handle this but couldn't — my operator may need to start one manually."
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
