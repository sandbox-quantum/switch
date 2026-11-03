import type { UsageTotal } from '../clients/switch-client.ts';

/**
 * What the agentic lane spends, and the limit it stops at.
 *
 * Two sources, both measured rather than guessed:
 *
 * - the driver and judge calls report their own cost (the Claude Code CLI
 *   prices each call);
 * - the agent's session is priced from the tokens Switch itself records for
 *   it, per model (`GET /gateway/tenants/{tenant_id}/usage`), at the prices
 *   below. A model with no price here stops the run instead of counting as
 *   free.
 */

/** USD per million tokens. */
export interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/**
 * List prices from Anthropic's public pricing page
 * (platform.claude.com/docs/en/about-claude/pricing), read 2026-10-19. Cache
 * writes are priced at the five-minute rate, the one Claude Code uses by
 * default; Switch records cache writes without their duration.
 */
export const PRICES: Readonly<Record<string, Price>> = {
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // Claude Code's own background work (titles, summaries) runs on it.
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
};

const METRIC_TO_PRICE: Readonly<Record<string, keyof Price>> = {
  input_tokens: 'input',
  output_tokens: 'output',
  cache_read_tokens: 'cacheRead',
  cache_write_tokens: 'cacheWrite',
};

/**
 * A model id as priced. A dated snapshot is priced as its model, however the
 * provider spells the date: `claude-haiku-4-5-20251001` from Anthropic's API,
 * `claude-haiku-4-5@20251001` from Vertex.
 */
export function priceOf(model: string): Price {
  const price = PRICES[model] ?? PRICES[model.replace(/[-@]\d{8}$/, '')];
  if (price === undefined) {
    throw new Error(
      `No price for model '${model}', so what it spent cannot be counted against the limit. ` +
        `Add it to PRICES in src/agentic/spend.ts from the public pricing page.`
    );
  }
  return price;
}

/** What one client spent, in USD, from its usage rows. Rows that are not tokens (turns, messages) cost nothing. */
export function usageCostUsd(rows: readonly UsageTotal[]): number {
  let usd = 0;
  for (const row of rows) {
    const field = METRIC_TO_PRICE[row.metric];
    if (field === undefined) continue;
    usd += (row.amount * priceOf(row.model)[field]) / 1_000_000;
  }
  return usd;
}

/** Each model's tokens, for the report: `claude-sonnet-5 12,345 in / 678 out / 90,000 cached`. */
export function describeUsage(rows: readonly UsageTotal[]): string {
  const byModel = new Map<string, Record<string, number>>();
  for (const row of rows) {
    // Turns and messages are counted without a model; they are not tokens.
    if (METRIC_TO_PRICE[row.metric] === undefined) continue;
    const counts = byModel.get(row.model) ?? {};
    counts[row.metric] = (counts[row.metric] ?? 0) + row.amount;
    byModel.set(row.model, counts);
  }
  if (byModel.size === 0) return 'no tokens recorded';
  const n = (value: number | undefined) => (value ?? 0).toLocaleString('en-US');
  return [...byModel]
    .map(
      ([model, c]) =>
        `${model} ${n(c.input_tokens)} in / ${n(c.output_tokens)} out / ` +
        `${n(c.cache_read_tokens)} cache read / ${n(c.cache_write_tokens)} cache write`
    )
    .join('; ');
}

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

/** The lane's running total against its limit. */
export class Ledger {
  readonly budgetUsd: number;
  private harnessUsd = 0;
  private agentUsd = 0;

  constructor(budgetUsd: number) {
    this.budgetUsd = budgetUsd;
  }

  /** A driver or judge call's cost. */
  addHarness(usd: number): void {
    this.harnessUsd += usd;
  }

  /** The agent's spend so far this run, as Switch last reported it. */
  setAgent(usd: number): void {
    this.agentUsd = usd;
  }

  get totalUsd(): number {
    return this.harnessUsd + this.agentUsd;
  }

  get remainingUsd(): number {
    return Math.max(0, this.budgetUsd - this.totalUsd);
  }

  /** Throw once the limit is reached: nothing more may be spent this run. */
  assertWithin(what: string): void {
    if (this.totalUsd >= this.budgetUsd) {
      throw new BudgetExceededError(
        `The spending limit of $${this.budgetUsd.toFixed(2)} is reached ($${this.totalUsd.toFixed(4)} spent) ` +
          `before ${what}. Raise SWITCH_E2E_AGENTIC_BUDGET_USD only if that spend was expected.`
      );
    }
  }

  describe(): string {
    return (
      `$${this.totalUsd.toFixed(4)} of $${this.budgetUsd.toFixed(2)} ` +
      `(agent $${this.agentUsd.toFixed(4)}, driver and judge $${this.harnessUsd.toFixed(4)})`
    );
  }
}
