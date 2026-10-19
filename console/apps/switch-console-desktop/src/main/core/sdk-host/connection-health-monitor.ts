import { type WatcherHealth, watcherHealthFileSchema } from '@switch-console/agent-providers';
import {
  CONNECTION_GRACE_MS,
  type AgentConnectionHealth,
  classifyWatcher,
  type RoomHealthSnapshot,
  type WatcherReport,
} from '@shared/core/switch-rooms/connection-health';
import type { HostWatcherStatus } from './host-watchers';

/** A local agent's room watcher, running inside Console. */
export type LocalHealthSource = {
  health(): WatcherHealth;
  onHealth(listener: (health: WatcherHealth) => void): () => void;
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
  /**
   * What a remote agent's watcher is doing, from its host's files: one read
   * shared by every agent on the host. Null when the host has no watcher for
   * the agent; raises when the host cannot be read.
   */
  remoteWatcher: (agentId: string) => Promise<HostWatcherStatus | null>;
  emit: (serverId: string, snapshot: RoomHealthSnapshot) => void;
  redact: (text: string) => string;
  logError: (message: string, context: Record<string, unknown>) => void;
  now: () => number;
  /** How often a remote agent's host is read again. */
  pollMs: number;
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
 * session attends which room, so its own account is what is shown: in-process
 * for a local agent, and for a remote one from the state it writes on its
 * host, read every `pollMs` with the rest of that host's watchers. Every
 * change is pushed on as the server's whole snapshot. A host that cannot be
 * read is reported as such, and read again on the next round.
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

  /**
   * One agent's session placements (session id → room id) as its watcher last
   * reported them, or null while it cannot be asked. Call after
   * {@link snapshot} has attached the agent's server.
   */
  placementsOf(agentId: string): Record<string, string> | null {
    return this.entries.get(agentId)?.source?.health?.placements ?? null;
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

  /**
   * A remote agent's watcher, read from its host every `pollMs`.
   *
   * Asked rather than listened to: a connection to the sidecar that dies
   * without saying so — across an SSH reconnect, say — would otherwise leave
   * the last thing it carried on screen for good. A read that fails says so,
   * and the next one tries again.
   */
  private remoteSource(agent: LinkedAgent): Source {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let silentSince: number | null = null;
    const poll = async () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (disposed) return;
      try {
        const status = await this.deps.remoteWatcher(agent.id);
        if (disposed) return;
        const read = healthFromHost(status, silentSince, this.deps.now());
        silentSince = read.silentSince;
        if (source.unreachable || !sameHealth(source.health, read.health)) {
          source.health = read.health;
          source.unreachable = null;
          this.changed(agent.serverId);
        }
      } catch (error) {
        if (disposed) return;
        const detail = `Could not read the agent's state on its host: ${message(error)}`;
        if (source.health || source.unreachable?.detail !== detail) {
          source.health = null;
          source.unreachable = { detail, takenOver: null };
          this.changed(agent.serverId);
        }
      } finally {
        if (!disposed) {
          timer = setTimeout(() => void poll(), this.deps.pollMs);
          timer.unref?.();
        }
      }
    };
    const source: Source = {
      remote: true,
      switchAgentId: agent.switchAgentId,
      health: null,
      unreachable: null,
      ready: Promise.resolve(),
      retry: () => {
        source.ready = poll();
        return source.ready;
      },
      dispose: () => {
        disposed = true;
        if (timer) clearTimeout(timer);
      },
    };
    source.ready = poll();
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

const sameHealth = (a: WatcherHealth | null, b: WatcherHealth): boolean =>
  a !== null && JSON.stringify(a) === JSON.stringify(b);

/**
 * A remote watcher's health, from what its host's files say.
 *
 * The watcher writes its own connection state beside its other files; that is
 * taken only from the process alive now, so a file a previous watcher left
 * does not speak for this one. A watcher that is alive but has written
 * nothing — just started, or a sidecar from before it wrote the file — is
 * given the usual grace from when it was first seen silent, and then named as
 * silent rather than guessed at. `silentSince` is carried from one read to the
 * next by the caller.
 */
export function healthFromHost(
  status: HostWatcherStatus | null,
  silentSince: number | null,
  now: number
): { health: WatcherHealth; silentSince: number | null } {
  const at = (since: number) => new Date(since).toISOString();
  if (!status)
    return {
      health: {
        state: 'not-running',
        detail: 'No room watcher has been set up for this agent on its host.',
        since: at(0),
        placements: {},
      },
      silentSince: null,
    };
  if (status.takenOver || status.stoodDown)
    return {
      health: {
        state: 'taken-over',
        detail: status.takenOver?.reason ?? "Another client holds this agent's connection.",
        since: status.takenOver?.at || at(0),
        placements: {},
      },
      silentSince: null,
    };
  const written = watcherHealthFileSchema.safeParse(status.health);
  if (status.workerAlive && written.success && written.data.pid === status.workerPid) {
    const { pid: _pid, updatedAt: _updatedAt, ...health } = written.data;
    return { health, silentSince: null };
  }
  const since = silentSince ?? now;
  if (!status.workerAlive)
    return {
      health: {
        state: 'not-running',
        // A recorded failure is the reason; with none, it may just be
        // restarting, and the grace below decides.
        detail: status.failure,
        since: at(since),
        placements: {},
      },
      silentSince: since,
    };
  return {
    health: {
      state: 'not-running',
      detail:
        now - since < CONNECTION_GRACE_MS
          ? null
          : "The agent's room watcher is running but does not report its connection to Switch. Update its sidecar to this Console's build.",
      since: at(since),
      placements: {},
    },
    silentSince: since,
  };
}
