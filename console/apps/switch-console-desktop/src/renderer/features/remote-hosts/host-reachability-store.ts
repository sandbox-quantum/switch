import { makeAutoObservable, runInAction } from 'mobx';
import { events, rpc } from '@renderer/lib/ipc';
import {
  type HostReachability,
  hostReachabilityEventChannel,
  isHostBlocked,
  unknownHostReachability,
} from '@shared/core/remote-hosts/reachability';

/**
 * Renderer mirror of the main process's host reachability model (CHOO-1682).
 *
 * Every surface that needs to say "this host is down" — the sidebar badge, the
 * location panel, the add-agent modal — reads from here, so they cannot
 * disagree about a host's state or each render its own interpretation of a raw
 * ssh2 error. Hydrated once, then kept current by pushed events.
 */
export class HostReachabilityStore {
  private readonly byHost = new Map<string, HostReachability>();
  /** Hosts with a retry in flight, so buttons can show progress. */
  readonly retrying = new Set<string>();
  private hydrated = false;

  constructor() {
    makeAutoObservable(this);
    events.on(hostReachabilityEventChannel, (reachability) => {
      runInAction(() => {
        this.byHost.set(reachability.sshHost, reachability);
      });
    });
  }

  /** Load the current state for every known host. Idempotent. */
  async hydrate(): Promise<void> {
    if (this.hydrated) return;
    this.hydrated = true;
    const all = await rpc.remoteHosts.listReachability();
    runInAction(() => {
      for (const reachability of all) this.byHost.set(reachability.sshHost, reachability);
    });
  }

  /**
   * Reachability for a host. An unseen host reads as `unknown` rather than
   * throwing — the UI treats "not yet probed" as "no reason to warn".
   */
  get(sshHost: string): HostReachability {
    return this.byHost.get(sshHost) ?? unknownHostReachability(sshHost);
  }

  /** Whether a host is in a state that pauses host-dependent work. */
  isBlocked(sshHost: string | null | undefined): boolean {
    if (!sshHost) return false;
    return isHostBlocked(this.get(sshHost));
  }

  isRetrying(sshHost: string): boolean {
    return this.retrying.has(sshHost);
  }

  /**
   * Probe now, bypassing the backoff. On success this un-pauses every paused
   * host-dependent path in the main process, not just the current view.
   */
  async retry(sshHost: string): Promise<HostReachability> {
    runInAction(() => this.retrying.add(sshHost));
    try {
      const reachability = await rpc.remoteHosts.retryHost(sshHost);
      runInAction(() => this.byHost.set(sshHost, reachability));
      return reachability;
    } finally {
      runInAction(() => this.retrying.delete(sshHost));
    }
  }
}

export const hostReachabilityStore = new HostReachabilityStore();
