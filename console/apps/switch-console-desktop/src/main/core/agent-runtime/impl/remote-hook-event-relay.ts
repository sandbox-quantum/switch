import type { Duplex } from 'node:stream';
import type { RawHookRequest, RelayedHookEvent } from '@main/core/agent-hooks/hook-server';
import { httpGetJsonOverChannel, type SidecarChannelOpener } from './sidecar-http';

/**
 * Drains the remote sidecar's `/events` long-poll and replays each buffered
 * hook event through Switch Console's own hook path, so room joins, agent status,
 * and provider-session ids from a remote session reach Switch Console while the UI
 * is attached. The sidecar still handles every event VM-locally for injection;
 * this is a read-only mirror for Switch Console's display and persistence.
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
  /** The sidecar's incarnation. Absent from a pre-CHOO-1425 sidecar. */
  epoch?: number;
}

/** Re-resolves the sidecar's current port and token. */
export type EndpointResolver = () => Promise<{ port: number; token: string } | null>;

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

/** Failed polls before we suspect the endpoint itself moved and re-resolve it. */
const RESOLVE_AFTER_FAILURES = 2;

export class RemoteHookEventRelay {
  private cursor = 0;
  private epoch: number | null = null;
  private stopped = false;
  private channel: Duplex | null = null;
  private port: number;
  private token: string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deps: {
      opener: RelayChannelOpener;
      port: number;
      token: string;
      /**
       * Re-resolves the sidecar's endpoint after repeated failures. The port and
       * token are regenerated every time the sidecar starts, so without this a
       * relay outlives exactly one incarnation and then polls a dead port until
       * the app quits — taking `/disconnect` down with it.
       */
      resolveEndpoint?: EndpointResolver;
      /** Replays one relayed event through Switch Console's hook path. */
      sink: (raw: RawHookRequest) => Promise<void>;
      log: RemoteHookEventRelayLogger;
      sleep?: (ms: number) => Promise<void>;
    }
  ) {
    this.port = deps.port;
    this.token = deps.token;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The endpoint currently in use — moves when the sidecar is re-resolved. */
  get endpoint(): { port: number; token: string } {
    return { port: this.port, token: this.token };
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
          port: this.port,
          failureStreak,
          retryInMs: delayMs,
          error: String(error),
        });
        if (failureStreak >= RESOLVE_AFTER_FAILURES) await this.reresolve();
        await this.sleep(delayMs);
      }
    }
  }

  private async pollOnce(since: number): Promise<EventsResponse> {
    const channel = await this.deps.opener.openChannel(this.port);
    this.channel = channel;
    try {
      return await getEventsOverChannel(channel, this.port, this.token, since);
    } finally {
      channel.destroy();
      if (this.channel === channel) this.channel = null;
    }
  }

  /**
   * Ask for the sidecar's current endpoint and adopt it if it moved. A restarted
   * sidecar binds a fresh ephemeral port and mints a fresh token, so the values
   * this relay was constructed with are stale rather than merely unreachable.
   */
  private async reresolve(): Promise<void> {
    const resolve = this.deps.resolveEndpoint;
    if (!resolve) return;
    let next: { port: number; token: string } | null;
    try {
      next = await resolve();
    } catch (error) {
      this.deps.log.debug('RemoteHookEventRelay: endpoint re-resolve failed', {
        error: String(error),
      });
      return;
    }
    if (!next) return;
    if (next.port === this.port && next.token === this.token) return;
    this.deps.log.info('RemoteHookEventRelay: sidecar endpoint moved — following it', {
      from: this.port,
      to: next.port,
    });
    this.port = next.port;
    this.token = next.token;
  }

  private consume(result: EventsResponse): void {
    if (this.epoch === null) this.epoch = result.epoch ?? null;
    // A changed epoch means this is a different incarnation of the sidecar; its
    // sequence numbers restarted, so a cursor from the previous life would sit
    // above every new seq and silently suppress the lot. Reset instead of
    // comparing cursors across two unrelated streams.
    else if (result.epoch !== undefined && result.epoch !== this.epoch) {
      this.deps.log.info('RemoteHookEventRelay: sidecar restarted — re-anchoring event cursor', {
        port: this.port,
        previousEpoch: this.epoch,
        epoch: result.epoch,
        previousCursor: this.cursor,
      });
      this.epoch = result.epoch;
      this.cursor = 0;
    }

    const fresh = result.events.filter((e) => e.seq > this.cursor);
    if (fresh.length > 0) {
      this.deps.log.info('RemoteHookEventRelay: received events from sidecar', {
        port: this.port,
        count: fresh.length,
        cursor: this.cursor,
        oldestSeq: result.oldestSeq,
        latestSeq: result.latestSeq,
        types: fresh.map((e) => e.type),
      });
    } else {
      this.deps.log.debug('RemoteHookEventRelay: poll returned no new events', {
        port: this.port,
        cursor: this.cursor,
        latestSeq: result.latestSeq,
      });
    }
    if (this.cursor > 0 && result.oldestSeq > this.cursor + 1) {
      this.deps.log.warn(
        'RemoteHookEventRelay: dropped events (consumer fell behind ring buffer)',
        {
          port: this.port,
          cursor: this.cursor,
          oldestSeq: result.oldestSeq,
          dropped: result.oldestSeq - this.cursor - 1,
        }
      );
    }
    for (const event of result.events) {
      if (event.seq <= this.cursor) continue;
      this.cursor = event.seq;
      this.deps.log.info('RemoteHookEventRelay: replaying event into Switch Console', {
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
