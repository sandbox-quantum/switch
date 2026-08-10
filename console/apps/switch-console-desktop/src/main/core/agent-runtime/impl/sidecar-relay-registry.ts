import type { RawHookRequest } from '@main/core/agent-hooks/hook-server';
import { log } from '@main/lib/logger';
import { RemoteHookEventRelay, type EndpointResolver } from './remote-hook-event-relay';
import type { SidecarChannelOpener } from './sidecar-http';

/**
 * One hook-event relay per sidecar, shared by every session it serves.
 *
 * A sidecar is agent-scoped: one process on the VM serves every session in that
 * agent's repo dir, and its `/events` ring buffer already carries the events of
 * all of them. Switch Console routes each event by the `ptyId` the event itself
 * carries (see `dbContextResolver`), never by which relay delivered it — so a
 * single relay per sidecar is sufficient *and* correct.
 *
 * Before this registry a relay was created per session, so N sessions on one
 * sidecar meant N long-poll `direct-tcpip` channels churning against the same
 * SSH transport and every event replayed through the hook path N times. On one
 * real host that was 54 relays for 13 sidecars, with 16 relays on the busiest.
 *
 * Ref-counted: the relay starts on the first acquire and stops on the last
 * release. Releasing is a teardown operation only — evicting a session's PTY
 * must NOT release, or the evicted session would go status-blind while its
 * agent carries on working.
 */

/** Identifies the one sidecar process a set of sessions share. */
export function sidecarRelayKey(params: {
  connectionId: string;
  repoDir: string;
  credsSlug: string;
}): string {
  return `${params.connectionId}::${params.repoDir}::${params.credsSlug}`;
}

/** A session's interest in one sidecar's event stream. */
export interface RelaySubscriber {
  readonly sessionId: string;
  /** Called for every `session-terminated` broadcast; the subscriber filters for its own id. */
  onSessionTerminated(rawBody: string): void;
}

export interface RelayAcquireParams {
  key: string;
  /** The agent name the sidecar is keyed on — log attribution only. */
  credsSlug: string;
  subscriber: RelaySubscriber;
  opener: SidecarChannelOpener;
  port: number;
  token: string;
  /**
   * Re-resolves the sidecar endpoint after repeated poll failures. Captured
   * from the first subscriber and kept for the entry's whole life — a restarted
   * sidecar binds a fresh port and token, and the relay must follow it even
   * after the session that first opened it is gone.
   */
  resolveEndpoint: EndpointResolver;
  /** Replays a non-terminated event through Switch Console's hook path. Called once per event. */
  sink: (raw: RawHookRequest) => Promise<void>;
}

interface RelayEntry {
  relay: RemoteHookEventRelay;
  subscribers: Map<string, RelaySubscriber>;
}

export class SidecarRelayRegistry {
  private readonly entries = new Map<string, RelayEntry>();

  /**
   * Join `subscriber` to the relay for `key`, starting one if this is the first
   * subscriber. Re-acquiring for a session id already present replaces that
   * subscriber (a re-provisioned runtime) without disturbing the relay.
   */
  acquire(params: RelayAcquireParams): void {
    const existing = this.entries.get(params.key);
    if (existing) {
      existing.subscribers.set(params.subscriber.sessionId, params.subscriber);
      return;
    }

    const subscribers = new Map<string, RelaySubscriber>([
      [params.subscriber.sessionId, params.subscriber],
    ]);

    const relay = new RemoteHookEventRelay({
      opener: params.opener,
      port: params.port,
      token: params.token,
      resolveEndpoint: params.resolveEndpoint,
      sink: async (raw) => {
        if (raw.type === 'session-terminated') {
          // Every session on this sidecar must hear it: the terminated id may
          // belong to any of them, and each filters for its own.
          for (const subscriber of [...subscribers.values()]) {
            subscriber.onSessionTerminated(raw.body);
          }
          return;
        }
        await params.sink(raw);
      },
      // Bound explicitly rather than inherited: the relay polls on its own timer
      // for as long as any session needs it, so a scope captured from whichever
      // session happened to start it would drift out of date.
      log: log.child({ component: 'hook-relay', agentSlug: params.credsSlug }),
    });

    this.entries.set(params.key, { relay, subscribers });
    relay.start();

    log.info('SidecarRelayRegistry: started shared relay', {
      sidecarKey: params.key,
      port: params.port,
    });
  }

  /**
   * Drop `sessionId`'s interest in `key`, stopping the relay when it was the
   * last. Teardown only — never call this to evict a PTY.
   */
  release(key: string, sessionId: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;

    entry.subscribers.delete(sessionId);
    if (entry.subscribers.size > 0) return;

    entry.relay.stop();
    this.entries.delete(key);
    log.info('SidecarRelayRegistry: stopped shared relay (last subscriber left)', {
      sidecarKey: key,
    });
  }

  /** The relay serving `key`, if one is running. */
  get(key: string): RemoteHookEventRelay | undefined {
    return this.entries.get(key)?.relay;
  }

  /** Live subscriber count for `key` — for tests and diagnostics. */
  subscriberCount(key: string): number {
    return this.entries.get(key)?.subscribers.size ?? 0;
  }

  /** Stop every relay and forget every subscriber. App shutdown and test teardown. */
  stopAll(): void {
    for (const entry of this.entries.values()) entry.relay.stop();
    this.entries.clear();
  }
}

export const sidecarRelayRegistry = new SidecarRelayRegistry();
