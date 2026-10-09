import {
  allFeatureFlagsOff,
  resolveFeatureFlags,
  sameFeatureFlags,
  type RemoteFeatureFlag,
  type ServerFeatureFlags,
} from '@shared/core/feature-flags/feature-flags';
import type { SwitchServer } from '@shared/core/switch-servers/switch-servers';

/** How often every server's flags are read again. Flags only change when a
 * server is redeployed, so a minute is plenty. */
export const FEATURE_FLAGS_POLL_INTERVAL_MS = 60_000;

export type FeatureFlagsServiceDeps = {
  listServers: () => Promise<SwitchServer[]>;
  fetchFlags: (server: SwitchServer) => Promise<RemoteFeatureFlag[]>;
  onChange: (state: ServerFeatureFlags) => void;
  warn: (message: string, error?: unknown) => void;
  intervalMs: number;
};

/**
 * Keeps the feature flags of every connected Switch server, reading each from
 * its gateway on a schedule and reporting a change as soon as it is seen.
 *
 * A failed read keeps the last values read and records the error, so a server
 * that is briefly unreachable does not flip its flags off; one never read
 * successfully has every flag off, with the reason it could not be read.
 */
export class FeatureFlagsService {
  private readonly states = new Map<string, ServerFeatureFlags>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;

  constructor(private readonly deps: FeatureFlagsServiceDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.refreshAll(), this.deps.intervalMs);
    void this.refreshAll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The server's flags as last read; every flag off if they have not been. */
  get(serverId: string): ServerFeatureFlags {
    return (
      this.states.get(serverId) ?? {
        serverId,
        flags: allFeatureFlagsOff(),
        fetchedAt: null,
        error: 'Not read yet',
      }
    );
  }

  /** Read every server's flags now. Concurrent calls share one pass. */
  refreshAll(): Promise<void> {
    this.inflight ??= this.readAll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async readAll(): Promise<void> {
    let servers: SwitchServer[];
    try {
      servers = await this.deps.listServers();
    } catch (error) {
      this.deps.warn('feature-flags: could not list servers; flags left as they were', error);
      return;
    }
    const known = new Set(servers.map((server) => server.id));
    for (const serverId of [...this.states.keys()]) {
      if (!known.has(serverId)) this.states.delete(serverId);
    }
    await Promise.all(servers.map((server) => this.readOne(server)));
  }

  private async readOne(server: SwitchServer): Promise<void> {
    const previous = this.states.get(server.id);
    let next: ServerFeatureFlags;
    try {
      const flags = resolveFeatureFlags(await this.deps.fetchFlags(server));
      next = { serverId: server.id, flags, fetchedAt: Date.now(), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      next = {
        serverId: server.id,
        flags: previous?.flags ?? allFeatureFlagsOff(),
        fetchedAt: previous?.fetchedAt ?? null,
        error: message,
      };
      if (previous?.error !== message) {
        this.deps.warn(
          `feature-flags: could not read the flags of server ${server.id}; ` +
            (previous?.fetchedAt ? 'keeping the last values read' : 'every flag is off'),
          error
        );
      }
    }
    this.states.set(server.id, next);
    if (
      !previous ||
      !sameFeatureFlags(previous.flags, next.flags) ||
      previous.error !== next.error
    ) {
      this.deps.onChange(next);
    }
  }
}
