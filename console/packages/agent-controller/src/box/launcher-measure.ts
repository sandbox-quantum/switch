import { type LauncherLink, type Measurement, QUIET_AFTER_MS } from './launcher-link';

/**
 * The launcher's latest `measure`, the split box's heartbeat, taken only while
 * fresh by the controller's own clock. Its figures are untrusted: they are
 * only the one-way tripwire of the valve's memory source check
 * (`totalBytes`), never what the valve reads.
 */
export class LauncherMeasure {
  private latest: { at: number; measurement: Measurement } | null = null;

  constructor(
    private readonly deps: {
      link: Pick<LauncherLink, 'current'>;
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
}
