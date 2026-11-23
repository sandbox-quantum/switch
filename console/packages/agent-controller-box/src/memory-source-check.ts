import type { Logger } from './log';
import type { BoxReading } from './memory-guard';

/** How far the launcher's agents may read above the box before it counts (noise, timing). */
export const SOURCE_CHECK_MARGIN_BYTES = 128 * 1024 * 1024;
/** Readings in a row the launcher's agents must be above the box before it counts. */
export const SOURCE_CHECK_SAMPLES = 3;

/** The sources that can see a split box's whole pod: an allow-list, so no source is no reading. */
const POD_SOURCES: readonly (BoxReading['source'] | undefined)[] = ['meminfo', 'meminfo_used'];

/**
 * Whether a split box's memory reading can see the whole pod. Under gVisor only `/proc/meminfo` shows the pod's total; the
 * cgroup figure is the controller's own container, blind to the agents. So
 * on a split box the box valve and the guard are taken as unprotected when:
 *
 * - the reading didn't come from meminfo (the cgroup, or no source at all); or
 * - the launcher's own total for the agents is above the box reading (by a
 *   margin, several readings in a row): the agents alone exceed it, so it
 *   can't be the pod's total.
 *
 * The second is a one-way tripwire: the launcher's figures are untrusted, so a
 * launcher that under-reports hides the sign (it never proves the reading is
 * good), and one that over-reports can only make its own box report
 * `unprotected`, which fails closed. The live retest's reading is the proof.
 * Off on a box without the split.
 */
export class MemorySourceCheck {
  private over = 0;
  private reason: 'not_meminfo' | 'below_agents' | null = null;

  constructor(
    private readonly deps: {
      split: boolean;
      /** The launcher's latest total for the agents, in bytes, or null when not fresh. */
      launcherTotal?: () => number | null;
      log: Pick<Logger, 'error' | 'info'>;
      marginBytes?: number;
      samples?: number;
    }
  ) {}

  /** `unprotected` while the reading can't be the pod's total; null otherwise, or off. */
  get problem(): 'unprotected' | null {
    return this.reason ? 'unprotected' : null;
  }

  /**
   * The bytes the valve may act on: on a split box a reading that didn't come
   * from meminfo counts as no reading (null), so the valve's fail-closed path holds
   * starts back and reports `unprotected`. Elsewhere,
   * the reading as it is.
   */
  usable(reading: BoxReading | null): number | null {
    if (reading === null) return null;
    if (this.deps.split && !POD_SOURCES.includes(reading.source)) return null;
    return reading.bytes;
  }

  /** Each box reading the valve takes. A failed one (null) is the valve's to report, not this. */
  observe(reading: BoxReading | null): void {
    if (!this.deps.split || reading === null) return;
    const total = this.deps.launcherTotal?.() ?? null;
    const margin = this.deps.marginBytes ?? SOURCE_CHECK_MARGIN_BYTES;
    this.over = total !== null && total > reading.bytes + margin ? this.over + 1 : 0;
    const reason = !POD_SOURCES.includes(reading.source)
      ? 'not_meminfo'
      : this.over >= (this.deps.samples ?? SOURCE_CHECK_SAMPLES)
        ? 'below_agents'
        : null;
    if (reason === this.reason) return;
    if (reason)
      this.deps.log.error(
        "The box's memory reading can't see the whole pod, so the valve and the guard aren't protecting it",
        { reason }
      );
    else this.deps.log.info("The box's memory reading sees the whole pod again", {});
    this.reason = reason;
  }
}
