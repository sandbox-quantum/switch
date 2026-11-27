import type { LauncherLink } from './launcher-link';

/** The agents' disk as Switch shows it: free and total bytes. */
export type DiskReading = { free: number; total: number };

/** How long one ask waits before the status report goes without a fresh figure. */
export const DISK_ASK_MS = 3_000;
/** How long a good reading stands in when an ask fails: a slow reply shouldn't blank the figure. */
export const DISK_STALE_MS = 60_000;

/**
 * The agents' disk on a split box: the agents' volume, which only
 * the launcher's container mounts, so the launcher measures it (`disk` order).
 * The controller's own data folder is a small volume of its own and is never
 * reported as the box's disk. When the launcher can't answer, the last good
 * reading stands for up to `DISK_STALE_MS`; after that it is unknown (null),
 * never the controller's disk.
 */
export class AgentsDisk {
  private last: { reading: DiskReading; at: number } | null = null;

  constructor(
    private readonly deps: {
      ask: () => ReturnType<LauncherLink['order']>;
      now: () => number;
      askMs?: number;
      staleMs?: number;
    }
  ) {}

  async reading(): Promise<DiskReading | null> {
    const fresh = await this.ask();
    if (fresh) {
      this.last = { reading: fresh, at: this.deps.now() };
      return fresh;
    }
    if (this.last && this.deps.now() - this.last.at <= (this.deps.staleMs ?? DISK_STALE_MS))
      return this.last.reading;
    this.last = null;
    return null;
  }

  private async ask(): Promise<DiskReading | null> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deps.askMs ?? DISK_ASK_MS);
      timer.unref?.();
    });
    try {
      const reply = await Promise.race([this.deps.ask().catch(() => null), late]);
      const disk = reply && reply.ok ? reply.disk : undefined;
      // A total of zero, or more free than total, is no reading at all.
      return disk && disk.total > 0 && disk.free <= disk.total ? { ...disk } : null;
    } finally {
      clearTimeout(timer);
    }
  }
}
