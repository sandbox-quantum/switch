import { type BoxReading, readBoxMemory } from './memory-guard';

/**
 * The box's memory on a split box, from `/proc/meminfo` only.
 *
 * Under gVisor the pod is one sandbox, and only `/proc/meminfo` shows the
 * whole of it: in the split test pod (v3.7) it rose with the agents' fill,
 * while the cgroup figure stayed at the controller container's own use. So on
 * a split box the cgroup is never consulted. If meminfo can't be read, the
 * reading is null, which the valve reports as `unprotected`, rather than a
 * cgroup figure that is blind to the agents (fail closed).
 */
export function readSplitBoxMemory(procRoot?: string): Promise<BoxReading | null> {
  return readBoxMemory({
    ...(procRoot === undefined ? {} : { procRoot }),
    cgroupUsage: async () => null,
  });
}
