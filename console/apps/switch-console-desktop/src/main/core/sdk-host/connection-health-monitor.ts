import type { WatcherHealth } from '@switch-console/agent-providers';
import {
  type AgentConnectionHealth,
  classifyWatcher,
  type RoomHealthSnapshot,
  type WatcherReport,
} from '@shared/core/switch-rooms/connection-health';

/** A local agent's room watcher, running inside Console. */
export type LocalHealthSource = {
  health(): WatcherHealth;
  onHealth(listener: (health: WatcherHealth) => void): () => void;
};

/** A remote agent's room watcher, reached through its sidecar's control port. */
export type RemoteHealthSource = {
  health(): Promise<WatcherHealth>;
  onHealth(listener: (health: WatcherHealth) => void): Promise<() => void>;
  onClose(listener: (error: Error) => void): () => void;
};

export type LinkedAgent = {
  id: string;
  serverId: string;
  switchAgentId: string;
  locationId: string;
};

export type ConnectionHealthDeps = {
  /** The server's agents that are linked to Switch. Raises for an unknown server. */
  linkedAgents: (serverId: string) => Promise<LinkedAgent[]>;
  /** Whether the agent runs on an SSH host, and so has a sidecar. */
  isRemote: (agent: LinkedAgent) => Promise<boolean>;
  /** Agents whose room connection a person stopped from Console. */
  stoppedAgentIds: () => Promise<string[]>;
  local: (switchAgentId: string) => LocalHealthSource;
  remote: (agentId: string) => Promise<RemoteHealthSource>;
  /**
   * What the sidecar's files on its host say about why it is not answering:
   * a takeover it stood down for, or the failure it recorded.
   */
  remoteStatus: (
    agentId: string
  ) => Promise<{ takenOver: { reason: string } | null; failure: string | null } | null>;
  emit: (serverId: string, snapshot: RoomHealthSnapshot) => void;
  redact: (text: string) => string;
  logError: (message: string, context: Record<string, unknown>) => void;
  now: () => number;
  /** How long after failing to reach a sidecar it is tried again. */
  retryMs: number;
};

type Source = {
  remote: boolean;
  switchAgentId: string;
  /** The watcher's last word; null while it cannot be reached. */
  health: WatcherHealth | null;
  unreachable: { detail: string; takenOver: string | null } | null;
  /** Settles once the source has been asked the first time, answered or not. */
  ready: Promise<void>;
  /** Try a sidecar that could not be reached again now. */
  retry: () => Promise<void>;
  dispose: () => void;
};

type Entry = { serverId: string; source: Source | null; error: string | null };

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Each linked agent's room connection, from the agent's own room watcher.
 *
 * The watcher holds the agent's one connection to Switch and decides which
 * session attends which room, so it is asked directly: in-process for a local
 * agent, through the sidecar's control port for a remote one. Every change it
 * reports is pushed on as the server's whole snapshot. A sidecar that cannot
 * be reached is reported as such, and tried again every `retryMs`.
 */
export class ConnectionHealthMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly dirty = new Set<string>();
  private readonly pushing = new Set<string>();
  private readonly graceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly deps: ConnectionHealthDeps) {}

  /** The server's snapshot now, watching every linked agent's watcher from here on. */
  async snapshot(serverId: string): Promise<RoomHealthSnapshot> {
    const agents = await this.deps.linkedAgents(serverId);
    for (const [agentId, entry] of this.entries)
      if (entry.serverId === serverId && !agents.some((agent) => agent.id === agentId))
        this.detach(agentId);
    await Promise.all(agents.map((agent) => this.attach(agent)));
    return this.compute(serverId);
  }

  /** Stops watching every agent. */
  dispose(): void {
    for (const agentId of [...this.entries.keys()]) this.detach(agentId);
    for (const timer of this.graceTimers.values()) clearTimeout(timer);
    this.graceTimers.clear();
  }

  private detach(agentId: string): void {
    this.entries.get(agentId)?.source?.dispose();
    this.entries.delete(agentId);
  }

  private async attach(agent: LinkedAgent): Promise<void> {
    let remote: boolean;
    try {
      remote = await this.deps.isRemote(agent);
    } catch (error) {
      this.detach(agent.id);
      this.entries.set(agent.id, {
        serverId: agent.serverId,
        source: null,
        error: `Could not tell where this agent runs: ${message(error)}`,
      });
      return;
    }
    const existing = this.entries.get(agent.id);
    if (
      existing?.source &&
      existing.serverId === agent.serverId &&
      existing.source.remote === remote &&
      existing.source.switchAgentId === agent.switchAgentId
    ) {
      if (existing.source.unreachable) await existing.source.retry();
      return;
    }
    this.detach(agent.id);
    const source = remote ? this.remoteSource(agent) : this.localSource(agent);
    this.entries.set(agent.id, { serverId: agent.serverId, source, error: null });
    await source.ready;
  }

  private localSource(agent: LinkedAgent): Source {
    const control = this.deps.local(agent.switchAgentId);
    const source: Source = {
      remote: false,
      switchAgentId: agent.switchAgentId,
      health: control.health(),
      unreachable: null,
      ready: Promise.resolve(),
      retry: () => Promise.resolve(),
      dispose: () => {},
    };
    source.dispose = control.onHealth((health) => {
      source.health = health;
      this.changed(agent.serverId);
    });
    return source;
  }

  private remoteSource(agent: LinkedAgent): Source {
    let disposed = false;
    let cleanup: (() => void)[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    const release = () => {
      for (const stop of cleanup) stop();
      cleanup = [];
      if (timer) clearTimeout(timer);
      timer = null;
    };
    const lost = async (error: unknown) => {
      release();
      if (disposed) return;
      let detail = message(error);
      let takenOver: string | null = null;
      try {
        const status = await this.deps.remoteStatus(agent.id);
        takenOver = status?.takenOver?.reason ?? null;
        if (status?.failure) detail = `${detail} The sidecar last stopped with: ${status.failure}`;
      } catch (statusError) {
        detail = `${detail} Its state on the host could not be read either: ${message(statusError)}`;
      }
      if (disposed) return;
      source.health = null;
      source.unreachable = { detail, takenOver };
      timer = setTimeout(() => void connect(), this.deps.retryMs);
      this.changed(agent.serverId);
    };
    const connect = async () => {
      release();
      if (disposed) return;
      try {
        const client = await this.deps.remote(agent.id);
        const update = (health: WatcherHealth) => {
          if (disposed) return;
          source.health = health;
          source.unreachable = null;
          this.changed(agent.serverId);
        };
        cleanup.push(await client.onHealth(update));
        cleanup.push(client.onClose((error) => void lost(error)));
        update(await client.health());
      } catch (error) {
        await lost(error);
      }
    };
    const source: Source = {
      remote: true,
      switchAgentId: agent.switchAgentId,
      health: null,
      unreachable: null,
      ready: Promise.resolve(),
      retry: () => {
        source.ready = connect();
        return source.ready;
      },
      dispose: () => {
        disposed = true;
        release();
      },
    };
    source.ready = connect();
    return source;
  }

  /** Pushes the server's snapshot, once for any number of changes that arrive while one is worked out. */
  private changed(serverId: string): void {
    this.dirty.add(serverId);
    if (this.pushing.has(serverId)) return;
    this.pushing.add(serverId);
    void (async () => {
      try {
        while (this.dirty.delete(serverId)) this.deps.emit(serverId, await this.compute(serverId));
      } catch (error) {
        this.deps.logError('Could not push the room connection health', {
          serverId,
          error: message(error),
        });
      } finally {
        this.pushing.delete(serverId);
      }
    })();
  }

  private async compute(serverId: string): Promise<RoomHealthSnapshot> {
    const entries = [...this.entries].filter(([, entry]) => entry.serverId === serverId);
    await Promise.all(entries.map(([, entry]) => entry.source?.ready ?? Promise.resolve()));
    const stopped = await this.deps.stoppedAgentIds();
    const now = this.deps.now();
    const agents: AgentConnectionHealth[] = [];
    const placements: Record<string, string> = {};
    let recheck: number | null = null;
    for (const [agentId, { source, error }] of entries) {
      if (!source) {
        agents.push({ agentId, state: 'unknown', detail: this.deps.redact(error ?? '') });
        continue;
      }
      let report: WatcherReport;
      if (source.health) {
        report = {
          kind: 'watcher',
          state: source.health.state,
          detail: source.health.detail,
          since: Date.parse(source.health.since),
        };
        Object.assign(placements, source.health.placements);
      } else if (source.unreachable) report = { kind: 'unreachable', ...source.unreachable };
      else throw new Error(`Agent ${agentId}'s room watcher was never asked for its state.`);
      const shown = classifyWatcher({ stopped: stopped.includes(agentId), report, now });
      if (shown.graceUntil !== null) recheck = Math.min(recheck ?? Infinity, shown.graceUntil);
      agents.push({
        agentId,
        state: shown.state,
        detail: shown.detail === null ? null : this.deps.redact(shown.detail),
      });
    }
    const timer = this.graceTimers.get(serverId);
    if (timer) clearTimeout(timer);
    this.graceTimers.delete(serverId);
    if (recheck !== null)
      this.graceTimers.set(
        serverId,
        setTimeout(() => this.changed(serverId), Math.max(0, recheck - now))
      );
    return { agents, placements };
  }
}
