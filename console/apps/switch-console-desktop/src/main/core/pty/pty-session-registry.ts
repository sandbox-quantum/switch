import { events } from '@main/lib/events';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { ptyDataChannel, ptyExitChannel, ptyInputChannel } from '@shared/core/pty/ptyEvents';
import { ptyStartedChannel } from '@shared/events/appEvents';
import type { Pty, PtyExitInfo } from './pty';

export interface PtySessionMetadata {
  providerId?: AgentProviderId;
  title?: string;
  isRemote?: boolean;
}

const FLUSH_INTERVAL_MS = 16; // ~60 fps
const RING_BUFFER_CAP = 64 * 1024; // 64 KB per session

export class PtySessionRegistry {
  private ptyMap: Map<string, Pty> = new Map();
  private ptyInputSubscriptions: Map<string, () => void> = new Map();
  private ringBuffers: Map<string, string> = new Map();
  private activeConsumers: Set<string> = new Set();
  private metadata: Map<string, PtySessionMetadata> = new Map();
  private lastSizes: Map<string, { cols: number; rows: number }> = new Map();
  private pendingFlushes: Map<string, () => void> = new Map();
  private openForInjection: Set<string> = new Set();

  register(
    sessionId: string,
    pty: Pty,
    options?: { preserveBufferOnExit?: boolean; metadata?: PtySessionMetadata }
  ): void {
    const preserveBufferOnExit = options?.preserveBufferOnExit ?? false;

    // Clear any stale ring buffer and consumer from a previous PTY at this sessionId (respawn)
    this.ptyInputSubscriptions.get(sessionId)?.();
    this.ptyInputSubscriptions.delete(sessionId);
    this.pendingFlushes.delete(sessionId);
    this.ringBuffers.delete(sessionId);
    this.activeConsumers.delete(sessionId);
    this.metadata.delete(sessionId);
    this.openForInjection.delete(sessionId);
    if (options?.metadata) this.metadata.set(sessionId, options.metadata);

    this.ptyMap.set(sessionId, pty);

    // Apply a size that arrived while this pty was still being created.
    //
    // A remote session opens its terminal over SSH, and the renderer mounts and
    // measures its pane partway through: the measurement lands after the spawn
    // size was read and before there is a pty to resize. Without this the pty
    // keeps the size it was spawned with — 80x24 in a pane twice that — until
    // something moves the pane, which is why switching away and back fixed it.
    const desiredSize = this.lastSizes.get(sessionId);
    if (desiredSize) pty.resize(desiredSize.cols, desiredSize.rows);

    let buffer = '';
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const flush = () => {
      if (this.ptyMap.get(sessionId) !== pty) {
        buffer = '';
        flushTimer = null;
        return;
      }
      if (buffer) {
        events.emit(ptyDataChannel, buffer, sessionId);
        buffer = '';
      }
      flushTimer = null;
    };
    this.pendingFlushes.set(sessionId, flush);

    pty.onData((data) => {
      if (this.ptyMap.get(sessionId) !== pty) return;
      buffer += data;
      if (!flushTimer) {
        flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
      }
      // Accumulate into ring buffer for late-connecting renderers
      let rb = (this.ringBuffers.get(sessionId) ?? '') + data;
      if (rb.length > RING_BUFFER_CAP) rb = rb.slice(-RING_BUFFER_CAP);
      this.ringBuffers.set(sessionId, rb);
    });

    pty.onExit((info) => {
      const isCurrentPty = this.ptyMap.get(sessionId) === pty;
      if (!isCurrentPty) return;

      // Flush any buffered output before emitting exit
      if (flushTimer !== null) {
        clearTimeout(flushTimer);
        flush();
      }
      events.emit(ptyExitChannel, info, sessionId);
      if (preserveBufferOnExit) {
        // Partial cleanup: keep ring buffer so late-connecting renderers can replay output
        this.ptyMap.delete(sessionId);
        this.ptyInputSubscriptions.get(sessionId)?.();
        this.ptyInputSubscriptions.delete(sessionId);
        this.pendingFlushes.delete(sessionId);
        this.lastSizes.delete(sessionId);
      } else {
        this.unregister(sessionId);
      }
    });

    const off = events.on(
      ptyInputChannel,
      (data) => {
        pty.write(data);
      },
      sessionId
    );

    this.ptyInputSubscriptions.set(sessionId, off);
    events.emit(ptyStartedChannel, { id: sessionId });
  }

  /**
   * `preserveSize` keeps the last known terminal dimensions after the pty is
   * gone. Set it when the session is expected to come back — a detached remote
   * session re-attaches onto the same tmux pane, and without the remembered
   * size it respawns at the 80x24 default and tmux repaints the pane at that
   * size inside a much larger terminal.
   */
  unregister(
    sessionId: string,
    options: { pty?: Pty; exitInfo?: PtyExitInfo; preserveSize?: boolean } = {}
  ): void {
    if (options.pty !== undefined && this.ptyMap.get(sessionId) !== options.pty) return;
    this.pendingFlushes.get(sessionId)?.();
    if (options.exitInfo !== undefined) {
      events.emit(ptyExitChannel, options.exitInfo, sessionId);
    }
    this.ptyMap.delete(sessionId);
    this.ptyInputSubscriptions.get(sessionId)?.();
    this.ptyInputSubscriptions.delete(sessionId);
    this.pendingFlushes.delete(sessionId);
    this.ringBuffers.delete(sessionId);
    this.activeConsumers.delete(sessionId);
    this.metadata.delete(sessionId);
    this.openForInjection.delete(sessionId);
    if (!options.preserveSize) this.lastSizes.delete(sessionId);
  }

  get(sessionId: string): Pty | undefined {
    return this.ptyMap.get(sessionId);
  }

  /**
   * Declare that the session's own opening prompt is in, so anything else may
   * now type into it.
   *
   * A session is launched with a prompt of its own and a TUI that is not ready
   * for it for a second or two, and the runtime holds that prompt back until it
   * is. Meanwhile a room message can arrive — an auto-started session is
   * answering one, and its room connection opens before the terminal exists.
   * Writing it on arrival puts it into a booting TUI, or interleaves it with
   * the opening prompt; both read as the message never arriving.
   *
   * Cleared whenever the pty is registered or torn down, so a respawned session
   * starts closed again.
   */
  markOpenForInjection(sessionId: string): void {
    this.openForInjection.add(sessionId);
  }

  /** Whether {@link markOpenForInjection} has been declared for this session. */
  isOpenForInjection(sessionId: string): boolean {
    return this.openForInjection.has(sessionId);
  }

  /**
   * Atomically snapshot the ring buffer and register a consumer for future
   * IPC delivery. Returns the current ring buffer without deleting it.
   * Safe: runs in one synchronous tick — no PTY data can arrive between
   * snapshot and consumer registration.
   */
  subscribe(sessionId: string): string {
    const buf = this.ringBuffers.get(sessionId) ?? '';
    this.activeConsumers.add(sessionId);
    return buf;
  }

  /**
   * Remove the consumer registration for a session.
   * Called when the renderer disposes its FrontendPty.
   */
  unsubscribe(sessionId: string): void {
    this.activeConsumers.delete(sessionId);
  }

  getMetadata(sessionId: string): PtySessionMetadata | undefined {
    return this.metadata.get(sessionId);
  }

  /**
   * Record the dimensions the renderer measured and apply them to the pty.
   *
   * The size is remembered whether or not a pty is live, because for a remote
   * session it routinely is not: its terminal is opened asynchronously by the
   * attachment pool, long after the renderer measured its pane and reported.
   * The renderer reports once and then only on an actual pane change, so a size
   * dropped here is not sent again — the attach falls back to 80x24 and stays
   * there. Keeping it means the attach spawns at the size the pane already has.
   *
   * The return value still reports only whether a live pty was resized, so a
   * remembered size cannot be mistaken for one that reached a process.
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    this.lastSizes.set(sessionId, { cols, rows });
    const pty = this.ptyMap.get(sessionId);
    if (!pty) return false;
    pty.resize(cols, rows);
    return true;
  }

  getLastSize(sessionId: string): { cols: number; rows: number } | undefined {
    return this.lastSizes.get(sessionId);
  }

  /** Active PTYs with local OS PID; SSH entries have `pid: undefined`. */
  listActiveSessions(): Array<{
    sessionId: string;
    pid: number | undefined;
    metadata?: PtySessionMetadata;
  }> {
    const out: Array<{
      sessionId: string;
      pid: number | undefined;
      metadata?: PtySessionMetadata;
    }> = [];
    for (const [sessionId, pty] of this.ptyMap) {
      out.push({
        sessionId,
        pid: pty.getPid?.(),
        metadata: this.metadata.get(sessionId),
      });
    }
    return out;
  }
}

export const ptySessionRegistry = new PtySessionRegistry();
