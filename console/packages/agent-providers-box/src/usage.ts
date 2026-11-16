import type { TokenUsage } from './events';

export type UsageCounts = Omit<TokenUsage, 'model'>;
type Counts = UsageCounts;

const FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const;

function spent(counts: Counts): boolean {
  return FIELDS.some((field) => counts[field] > 0);
}

/**
 * Turns a provider's running per-model totals into what was spent since the
 * last call.
 *
 * A total that went down means the provider started counting again (a resumed
 * session, a cleared conversation), so the new total is all new spend. A
 * report with nothing in it at all is ignored rather than taken as a reset:
 * providers send zeroed totals on a crash, and treating that as a restart
 * would count the next real total twice.
 */
export class CumulativeUsage {
  private baseline = new Map<string, Counts>();
  private hasStarted = false;

  /** Whether any totals have been taken yet. */
  get started(): boolean {
    return this.hasStarted;
  }

  /**
   * Treats `totals` as already counted, for a provider whose first report
   * includes spend from before this process was watching.
   */
  startFrom(totals: ReadonlyMap<string, Counts>): void {
    this.baseline = new Map(totals);
    this.hasStarted = true;
  }

  advance(totals: ReadonlyMap<string, Counts>): TokenUsage[] {
    if (![...totals.values()].some(spent)) return [];
    const usage: TokenUsage[] = [];
    for (const [model, total] of totals) {
      const before = this.baseline.get(model);
      const reset = before !== undefined && FIELDS.some((field) => total[field] < before[field]);
      const delta: TokenUsage = { model, ...total };
      if (before && !reset) {
        for (const field of FIELDS) delta[field] = total[field] - before[field];
      }
      if (spent(delta)) usage.push(delta);
    }
    this.baseline = new Map(totals);
    this.hasStarted = true;
    return usage;
  }
}

/** Adds `more` into `into`, one entry per model. */
export function mergeUsage(into: TokenUsage[], more: readonly TokenUsage[]): TokenUsage[] {
  const byModel = new Map(into.map((entry) => [entry.model, { ...entry }]));
  for (const entry of more) {
    const existing = byModel.get(entry.model);
    if (!existing) {
      byModel.set(entry.model, { ...entry });
      continue;
    }
    for (const field of FIELDS) existing[field] += entry[field];
  }
  return [...byModel.values()];
}
