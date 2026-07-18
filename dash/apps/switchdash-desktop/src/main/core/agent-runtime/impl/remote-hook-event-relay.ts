import type { Duplex } from 'node:stream';
import type { RawHookRequest, RelayedHookEvent } from '@main/core/agent-hooks/hook-server';
import { httpGetJsonOverChannel, type SidecarChannelOpener } from './sidecar-http';

/**
 * Drains the remote sidecar's `/events` long-poll and replays each buffered
 * hook event through switchdash's own hook path, so room joins, agent status,
 * and provider-session ids from a remote session reach switchdash while the UI
 * is attached. The sidecar still handles every event VM-locally for injection;
 * this is a read-only mirror for switchdash's display and persistence.
 *
 * Delivery is at-least-once with a cursor: each poll carries the seq of the
 * last event processed and receives everything newer. A gap (the consumer fell
 * past the sidecar's ring buffer) is logged, not silently swallowed.
 */

const REQUEST_TIMEOUT_MS = 30_000; // > the sidecar's 25s long-poll
/** Backoff (ms) between failed polls, clamped to the last step. A fixed 1s
 * retry hammered a dead connection with a log line per second for the whole
 * outage; recovery is the connection manager's job, so the relay only needs
 * to check back occasionally until the transport is rebuilt under it. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

interface EventsResponse {
  events: RelayedHookEvent[];
  oldestSeq: number;
  latestSeq: number;
}

/** Opens a duplex stream connected to `127.0.0.1:<port>` on the remote host. */
export type RelayChannelOpener = SidecarChannelOpener;

export interface RemoteHookEventRelayLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

function getEventsOverChannel(
  channel: Duplex,
  port: number,
  token: string,
  since: number
): Promise<EventsResponse> {
  return httpGetJsonOverChannel<EventsResponse>(channel, {
    port,
    token,
    path: `/events?since=${since}`,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

export class RemoteHookEventRelay {
  private cursor = 0;
  private stopped = false;
  private channel: Duplex | null = null;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: {
      opener: RelayChannelOpener;
      port: number;
      token: string;
      /** Replays one relayed event through switchdash's hook path. */
      sink: (raw: RawHookRequest) => Promise<void>;
      log: RemoteHookEventRelayLogger;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  start(): void {
    void this.loop();
  }

  stop(): void {
    this.stopped = true;
    this.channel?.destroy();
    this.channel = null;
  }

  private async loop(): Promise<void> {
    let failureStreak = 0;
    while (!this.stopped) {
      try {
        const result = await this.pollOnce(this.cursor);
        if (this.stopped) return;
        failureStreak = 0;
        this.consume(result);
      } catch (error) {
        if (this.stopped) return;
        failureStreak += 1;
        const delayMs = RETRY_DELAYS_MS[Math.min(failureStreak, RETRY_DELAYS_MS.length) - 1]!;
        this.deps.log.warn('RemoteHookEventRelay: poll failed, retrying', {
          port: this.deps.port,
          failureStreak,
          retryInMs: delayMs,
          error: String(error),
        });
        await this.sleep(delayMs);
      }
    }
  }

  private async pollOnce(since: number): Promise<EventsResponse> {
    const channel = await this.deps.opener.openChannel(this.deps.port);
    this.channel = channel;
    try {
      return await getEventsOverChannel(channel, this.deps.port, this.deps.token, since);
    } finally {
      channel.destroy();
      if (this.channel === channel) this.channel = null;
    }
  }

  private consume(result: EventsResponse): void {
    const fresh = result.events.filter((e) => e.seq > this.cursor);
    if (fresh.length > 0) {
      this.deps.log.info('RemoteHookEventRelay: received events from sidecar', {
        port: this.deps.port,
        count: fresh.length,
        cursor: this.cursor,
        oldestSeq: result.oldestSeq,
        latestSeq: result.latestSeq,
        types: fresh.map((e) => e.type),
      });
    } else {
      this.deps.log.debug('RemoteHookEventRelay: poll returned no new events', {
        port: this.deps.port,
        cursor: this.cursor,
        latestSeq: result.latestSeq,
      });
    }
    if (this.cursor > 0 && result.oldestSeq > this.cursor + 1) {
      this.deps.log.warn(
        'RemoteHookEventRelay: dropped events (consumer fell behind ring buffer)',
        {
          port: this.deps.port,
          cursor: this.cursor,
          oldestSeq: result.oldestSeq,
          dropped: result.oldestSeq - this.cursor - 1,
        }
      );
    }
    for (const event of result.events) {
      if (event.seq <= this.cursor) continue;
      this.cursor = event.seq;
      this.deps.log.info('RemoteHookEventRelay: replaying event into switchdash', {
        seq: event.seq,
        type: event.type,
        ptyId: event.ptyId,
      });
      void this.deps
        .sink({ ptyId: event.ptyId, type: event.type, body: event.body })
        .catch((error) => {
          this.deps.log.warn('RemoteHookEventRelay: sink failed for relayed event', {
            type: event.type,
            error: String(error),
          });
        });
    }
  }
}
