import { type LauncherLink, type Measurement, QUIET_AFTER_MS } from './launcher-link';
import type { GuardRemote } from './memory-guard';

/**
 * The memory guard's view through the launcher: the latest `measure`,
 * taken only while fresh by the controller's own clock, and the guard's stop
 * steps sent as orders. The launcher's figures are untrusted; the guard keeps
 * its own box reading beside them.
 */
export class LauncherGuard implements GuardRemote {
  private latest: { at: number; measurement: Measurement } | null = null;

  constructor(
    private readonly deps: {
      link: Pick<LauncherLink, 'order' | 'current'>;
      now: () => number;
      /** Whether the controller launched this agent: figures for any other are ignored and counted. */
      launched?: (agentId: string) => boolean;
      log?: (event: string, fields: Record<string, string | number>) => void;
    }
  ) {}

  /** `measure` entries for agents the controller never launched, ignored. */
  unknownEntries = 0;

  /** Wire to `LauncherLink`'s `onMeasure`. */
  measured(measurement: Measurement): void {
    const launched = this.deps.launched;
    if (launched) {
      const agents: Measurement['agents'] = {};
      let unknown = 0;
      for (const [agentId, entry] of Object.entries(measurement.agents)) {
        if (launched(agentId)) agents[agentId] = entry;
        else unknown++;
      }
      if (unknown > 0) {
        // Logged the first time and then each time the count passes a power of two.
        const before = this.unknownEntries;
        this.unknownEntries += unknown;
        if (before === 0 || Math.clz32(before) !== Math.clz32(this.unknownEntries))
          this.deps.log?.('measure_unknown_agent', { count: this.unknownEntries });
      }
      measurement = { ...measurement, agents };
    }
    this.latest = { at: this.deps.now(), measurement };
  }

  /** Forget the figures: the agents container restarted. */
  reset(): void {
    this.latest = null;
  }

  /**
   * The latest fresh total of the launched agents' undisputed bytes, or null
   * when there is none (the memory source check's one-way tripwire).
   */
  totalBytes(): number | null {
    if (this.deps.link.current !== 'live' || !this.latest) return null;
    if (this.deps.now() - this.latest.at >= QUIET_AFTER_MS) return null;
    let total = 0;
    for (const entry of Object.values(this.latest.measurement.agents))
      total += Math.max(0, entry.bytes - entry.disputedBytes);
    return total;
  }

  read(agentIds: readonly string[]): Map<string, { undisputed: number; processes: number }> | null {
    if (this.deps.link.current !== 'live' || !this.latest) return null;
    if (this.deps.now() - this.latest.at >= QUIET_AFTER_MS) return null;
    const out = new Map<string, { undisputed: number; processes: number }>();
    for (const agentId of agentIds) {
      const entry = this.latest.measurement.agents[agentId];
      if (entry)
        out.set(agentId, {
          undisputed: Math.max(0, entry.bytes - entry.disputedBytes),
          processes: entry.processes,
        });
    }
    return out;
  }

  async freeze(agentId: string): Promise<void> {
    await this.deps.link.order({ kind: 'freeze', agentId });
  }

  async thaw(agentId: string): Promise<void> {
    await this.deps.link.order({ kind: 'thaw', agentId });
  }

  async end(agentId: string): Promise<{ forced: number; notProven: number; left: number }> {
    const reply = await this.deps.link.order({ kind: 'end', agentId });
    if (!reply.ok || !reply.counts)
      throw new Error(`The launcher did not end the agent (${reply.code ?? 'failed'}).`);
    return {
      forced: reply.counts.signalled,
      notProven: reply.counts.notProven,
      left: reply.counts.left,
    };
  }
}
