import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionAttachmentChangedChannel } from '@shared/core/sessions/sessionEvents';
import { AttachQueue, AttachQueueClearedError } from './attach-queue';
import type { AttachReason, AttachState, AttachableRuntime } from './types';

/**
 * Bounds how many remote sessions hold a live terminal, per SSH host.
 *
 * Every session on a host shares one ssh2 transport. A terminal is a channel
 * held open for as long as it is attached, and an attach opens several more
 * (SFTP for hooks, an exec to resolve the CLI). One host with 51 attached
 * sessions saturated its tunnel, pushed channel opens past their deadline, and
 * tripped the connection manager's wedge watchdog — which rebuilt the transport,
 * prompting all 51 to re-attach in the same tick and wedge it again, every ~16
 * minutes indefinitely.
 *
 * The pool fixes both halves of that: a cap with LRU eviction keeps the steady
 * state small, and a per-host queue makes every attach serial and staggered so a
 * reconnect can never stampede. Eviction is cheap because a detached session is
 * not a stopped one — the agent keeps running in its tmux pane on the VM and its
 * shared sidecar relay keeps reporting status, room and notifications. Only the
 * view goes away.
 *
 * Local runtimes never register: they have no shared transport to protect.
 */

interface PoolEntry {
  runtime: AttachableRuntime;
  hostKey: string;
  state: AttachState;
}

export interface RemoteAttachmentPoolDeps {
  /** Resolves the per-host cap. Read per request so a settings change takes effect live. */
  readCap: () => Promise<number>;
  makeQueue?: () => AttachQueue;
  publish?: (payload: {
    sessionId: string;
    state: AttachState;
    hostKey: string;
    reason?: AttachReason;
  }) => void;
}

export class RemoteAttachmentPool {
  /**
   * Insertion-ordered by view recency: re-inserting on view puts a session at
   * the back, so the front is the least-recently-viewed eviction candidate.
   */
  private readonly entries = new Map<string, PoolEntry>();
  private readonly queues = new Map<string, AttachQueue>();
  /** Attaches in progress, so overlapping requests share one outcome. */
  private readonly inFlight = new Map<string, Promise<AttachState>>();
  private focusedSessionId: string | null = null;

  constructor(private readonly deps: RemoteAttachmentPoolDeps) {}

  // ─── Membership ──────────────────────────────────────────────────────────

  register(runtime: AttachableRuntime): void {
    const sessionId = runtime.attachSessionId;
    const existing = this.entries.get(sessionId);
    this.entries.set(sessionId, {
      runtime,
      hostKey: runtime.attachHostKey,
      // A re-provisioned runtime for a live session keeps its state.
      state: existing?.state ?? (runtime.isAttached() ? 'attached' : 'detached'),
    });

    // Focus can arrive before the runtime exists — the renderer reports it on
    // navigation while provisioning is still running — and a `setFocused` for an
    // unknown session has nothing to attach. Catch up here, or clicking a
    // not-yet-provisioned session would leave its terminal closed with nothing
    // to retry it.
    if (sessionId === this.focusedSessionId && !runtime.isAttached()) {
      void this.requestAttach(sessionId, 'focus').catch(() => {
        // requestAttach already recorded and published the failure.
      });
    }
  }

  unregister(sessionId: string): void {
    this.entries.delete(sessionId);
    if (this.focusedSessionId === sessionId) this.focusedSessionId = null;
  }

  stateOf(sessionId: string): AttachState {
    return this.entries.get(sessionId)?.state ?? 'detached';
  }

  capacityFor(hostKey: string): { cap: number; attached: number } {
    return { cap: this.lastKnownCap, attached: this.attachedOn(hostKey).length };
  }

  // ─── Focus ───────────────────────────────────────────────────────────────

  /**
   * Record which session the user is looking at. The focused session is pinned:
   * it is never chosen for eviction, and it is the first thing re-attached after
   * a reconnect. Pinning happens before the attach request, so the previously
   * focused session becomes evictable and a cap of 1 cannot deadlock.
   */
  setFocused(sessionId: string | null): void {
    this.focusedSessionId = sessionId;
    if (!sessionId) return;
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.touch(sessionId);
    void this.requestAttach(sessionId, 'focus').catch(() => {
      // requestAttach already recorded the failure and published it.
    });
  }

  /** Move a session to the most-recently-viewed end without attaching it. */
  noteViewed(sessionId: string): void {
    this.touch(sessionId);
  }

  // ─── Attach / detach ─────────────────────────────────────────────────────

  /**
   * Ensure `sessionId` has a live terminal, evicting the least-recently-viewed
   * session on its host if the host is at capacity. Never refuses: the caller
   * asked to see this session, and eviction is cheap.
   */
  async requestAttach(sessionId: string, reason: AttachReason): Promise<AttachState> {
    const entry = this.entries.get(sessionId);
    if (!entry) return 'detached';
    if (entry.runtime.isAttached()) {
      this.setState(entry, sessionId, 'attached', reason);
      return 'attached';
    }
    // Coalesce onto the attach already in flight rather than reporting a
    // half-truth: `setFocused` and an explicit request routinely overlap, and
    // both callers want the real outcome.
    const inFlight = this.inFlight.get(sessionId);
    if (inFlight) return inFlight;

    const attempt = this.performAttach(entry, sessionId, reason).finally(() => {
      if (this.inFlight.get(sessionId) === attempt) this.inFlight.delete(sessionId);
    });
    this.inFlight.set(sessionId, attempt);
    return attempt;
  }

  private async performAttach(
    entry: PoolEntry,
    sessionId: string,
    reason: AttachReason
  ): Promise<AttachState> {
    this.touch(sessionId);
    this.setState(entry, sessionId, 'attaching', reason);

    const queue = this.queueFor(entry.hostKey);
    try {
      await queue.run(async () => {
        // Re-check inside the queue: the session may have been unregistered, or
        // already attached by another request, while it waited its turn.
        const current = this.entries.get(sessionId);
        if (!current || current.runtime.isAttached()) return;
        await this.evictForCapacity(current.hostKey, sessionId);
        log.info('RemoteAttachmentPool: attaching session', {
          event: 'remote_attach',
          sessionId,
          hostKey: current.hostKey,
          reason,
          queueDepth: queue.depth,
          attachedCount: this.attachedOn(current.hostKey).length,
        });
        await current.runtime.attach();
      });
    } catch (error) {
      const cancelled = error instanceof AttachQueueClearedError;
      const live = this.entries.get(sessionId);
      if (live) this.setState(live, sessionId, cancelled ? 'detached' : 'failed', reason);
      if (!cancelled) {
        log.warn('RemoteAttachmentPool: attach failed', {
          sessionId,
          hostKey: entry.hostKey,
          reason,
          error: String(error),
        });
      }
      return cancelled ? 'detached' : 'failed';
    }

    const settled = this.entries.get(sessionId);
    if (!settled) return 'detached';
    const state: AttachState = settled.runtime.isAttached() ? 'attached' : 'detached';
    this.setState(settled, sessionId, state, reason);
    return state;
  }

  /** Detach a session's terminal on purpose, leaving its agent running. */
  async requestDetach(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    if (this.focusedSessionId === sessionId) this.focusedSessionId = null;
    await this.detach(entry, sessionId);
  }

  // ─── Connection lifecycle ────────────────────────────────────────────────

  /**
   * The transport for `hostKey` went away: every PTY on it died with it. Drop
   * queued attaches aimed at the dead transport and record the truth, so the UI
   * shows detached rather than a terminal that will never produce output.
   */
  handleConnectionLost(hostKey: string): void {
    this.queues.get(hostKey)?.clear();
    for (const [sessionId, entry] of this.entries) {
      if (entry.hostKey !== hostKey) continue;
      if (entry.state === 'detached') continue;
      this.setState(entry, sessionId, 'detached');
    }
  }

  /**
   * The transport for `hostKey` is back. Re-attach the focused session plus the
   * most-recently-viewed others up to the cap — staggered through the queue.
   *
   * The remaining sessions stay detached deliberately. Their agents never
   * stopped, and re-attaching all of them is precisely what used to re-wedge the
   * connection fifteen seconds later.
   */
  async replayAfterReconnect(hostKey: string): Promise<void> {
    const cap = await this.readCap();
    const candidates = this.replayOrder(hostKey).slice(0, cap);
    if (candidates.length === 0) return;

    log.info('RemoteAttachmentPool: replaying attachments after reconnect', {
      event: 'remote_attach_replay',
      hostKey,
      replaying: candidates.length,
      cap,
    });

    for (const sessionId of candidates) {
      void this.requestAttach(sessionId, 'reconnect').catch(() => {
        // Already logged and published by requestAttach.
      });
    }
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  /** Most-recently-viewed first, focused session always leading. */
  private replayOrder(hostKey: string): string[] {
    const onHost = [...this.entries]
      .filter(([, entry]) => entry.hostKey === hostKey)
      .map(([sessionId]) => sessionId)
      .reverse();
    const focused = this.focusedSessionId;
    if (focused && onHost.includes(focused)) {
      return [focused, ...onHost.filter((id) => id !== focused)];
    }
    return onHost;
  }

  private async evictForCapacity(hostKey: string, incomingSessionId: string): Promise<void> {
    const cap = await this.readCap();
    // The incoming session is not attached yet, so it needs a free slot.
    while (this.attachedOn(hostKey).length >= cap) {
      const victimId = this.evictionCandidate(hostKey, incomingSessionId);
      if (!victimId) return; // Everything attached is pinned or is the incoming session.
      const victim = this.entries.get(victimId);
      if (!victim) continue;
      log.info('RemoteAttachmentPool: evicting least-recently-viewed session', {
        event: 'remote_attach_evict',
        sessionId: victimId,
        hostKey,
        cap,
        forSessionId: incomingSessionId,
      });
      await this.detach(victim, victimId);
    }
  }

  /** Least-recently-viewed attached session on the host that may be evicted. */
  private evictionCandidate(hostKey: string, incomingSessionId: string): string | null {
    for (const [sessionId, entry] of this.entries) {
      if (entry.hostKey !== hostKey) continue;
      if (sessionId === incomingSessionId) continue;
      if (sessionId === this.focusedSessionId) continue;
      if (!entry.runtime.isAttached()) continue;
      return sessionId;
    }
    return null;
  }

  private async detach(entry: PoolEntry, sessionId: string): Promise<void> {
    try {
      await entry.runtime.detachForEviction();
    } catch (error) {
      log.warn('RemoteAttachmentPool: detach failed', {
        sessionId,
        hostKey: entry.hostKey,
        error: String(error),
      });
    }
    this.setState(entry, sessionId, 'detached');
  }

  private attachedOn(hostKey: string): string[] {
    return [...this.entries]
      .filter(([, entry]) => entry.hostKey === hostKey && entry.runtime.isAttached())
      .map(([sessionId]) => sessionId);
  }

  /** Re-insert so the session moves to the most-recently-viewed end of the map. */
  private touch(sessionId: string): void {
    const entry = this.entries.get(sessionId);
    if (!entry) return;
    this.entries.delete(sessionId);
    this.entries.set(sessionId, entry);
  }

  private queueFor(hostKey: string): AttachQueue {
    let queue = this.queues.get(hostKey);
    if (!queue) {
      queue = this.deps.makeQueue?.() ?? new AttachQueue();
      this.queues.set(hostKey, queue);
    }
    return queue;
  }

  private lastKnownCap = 4;

  private async readCap(): Promise<number> {
    try {
      this.lastKnownCap = Math.max(1, await this.deps.readCap());
    } catch (error) {
      log.warn('RemoteAttachmentPool: could not read attachment cap; using last known', {
        cap: this.lastKnownCap,
        error: String(error),
      });
    }
    return this.lastKnownCap;
  }

  private setState(
    entry: PoolEntry,
    sessionId: string,
    state: AttachState,
    reason?: AttachReason
  ): void {
    if (entry.state === state) return;
    entry.state = state;
    const payload = { sessionId, state, hostKey: entry.hostKey, reason };
    if (this.deps.publish) {
      this.deps.publish(payload);
      return;
    }
    events.emit(sessionAttachmentChangedChannel, payload);
  }
}
