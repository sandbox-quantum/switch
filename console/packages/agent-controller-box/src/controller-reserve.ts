import type { Logger } from './log';

const MIB = 1024 * 1024;

/**
 * The controller's reserve when a split box sets none, or sets one that
 * isn't valid (decision v4): a split box always keeps one.
 */
export const DEFAULT_CONTROLLER_RESERVE_BYTES = 256 * MIB;

/**
 * Memory kept back for the controller under the pod's limit on a split box:
 * the box valve's memory lines and the memory
 * guard work to the pod limit less this, so agents are parked or stopped
 * before they reach the controller's share. Under gVisor only the pod's limit
 * holds, not the controller container's own.
 *
 * `SWITCH_CONTROLLER_RESERVE_BYTES`, checked at start: a whole number of
 * bytes, above 0, at most half the pod limit. On a split box a value that is
 * unset or not valid falls back to 256 MiB with one error, so the controller
 * never runs with no reserve; elsewhere unset (or not valid) means none, and
 * nothing changes. Without a pod limit there is nothing to reserve under.
 */
export function controllerReserveFromEnv(
  env: NodeJS.ProcessEnv,
  options: {
    split: boolean;
    /** The pod's memory limit (`SWITCH_BOX_MEMORY_LIMIT_BYTES`), or null where none is set. */
    podLimit: number | null;
    log: Pick<Logger, 'warn' | 'error'>;
  }
): number {
  const { split, podLimit, log } = options;
  if (podLimit === null) return 0;
  const most = Math.floor(podLimit / 2);
  const fallback = Math.min(DEFAULT_CONTROLLER_RESERVE_BYTES, most);
  const raw = env.SWITCH_CONTROLLER_RESERVE_BYTES?.trim();
  if (!raw) {
    if (!split) return 0;
    log.error('No controller reserve is set on a split box; keeping the default', {
      reserveBytes: fallback,
    });
    return fallback;
  }
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  const valid = Number.isSafeInteger(value) && value > 0 && value <= most;
  if (valid) return value;
  if (split) {
    log.error(
      'The controller reserve is not a whole number of bytes above 0 and at most half the box limit; keeping the default',
      { reserveBytes: fallback, mostBytes: most }
    );
    return fallback;
  }
  log.warn(
    'The controller reserve is not a whole number of bytes above 0 and at most half the box limit; none is kept',
    { mostBytes: most }
  );
  return 0;
}

/**
 * The two limits the box valve is built from: its cap on the box's whole
 * limit (the cap already allows for the controller at rest), and its memory
 * lines (park, stop, refuse) on the limit less the reserve. Null without a
 * box limit.
 */
export function valveLimits(
  boxLimit: number | null,
  reserve: number
): { capLimit: number; lineLimit: number } | null {
  if (boxLimit === null) return null;
  return { capLimit: boxLimit, lineLimit: boxLimit - Math.max(0, reserve) };
}
