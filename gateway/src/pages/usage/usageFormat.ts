import { DAILY_CAP_MAX, DAILY_CAP_MIN, type UsageMetric } from "../../data/api";

const METRIC_LABELS: Record<UsageMetric, string> = {
  messages: "Messages",
  turns: "Turns",
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cache_read_tokens: "Cache read tokens",
  cache_write_tokens: "Cache write tokens",
  awake_minutes: "Awake minutes",
  hosted_ai_calls: "AI calls",
};

/** A whole number from 1 to `max` typed as digits only, or null. */
export function parseBound(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw.trim());
  return value >= 1 && value <= max ? value : null;
}

export function metricLabel(metric: UsageMetric): string {
  return METRIC_LABELS[metric];
}

/** How a budget's metric reads: AI calls are only ever the daily cap per person (L1b). */
export function budgetMetricLabel(metric: UsageMetric): string {
  return metric === "hosted_ai_calls" ? "Daily AI calls per person" : metricLabel(metric);
}

export function formatAmount(value: number): string {
  return value.toLocaleString();
}

/** `24h` → "day", `168h` → "week", anything else in hours. */
export function formatPeriod(hours: number): string {
  if (hours === 24) return "day";
  if (hours === 168) return "week";
  if (hours % 24 === 0) return `${hours / 24} days`;
  return `${hours}h`;
}

/** Why a daily AI cap can't be sent, or null when it can (visibility L1b). The
 * page holds it to what the gateway applies; Core checks its own bound again. */
export function dailyCapProblem(raw: string): string | null {
  const value = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (Number.isInteger(value) && value >= DAILY_CAP_MIN && value <= DAILY_CAP_MAX) return null;
  return `Choose between ${DAILY_CAP_MIN} and ${DAILY_CAP_MAX.toLocaleString("en")} a day.`;
}

/**
 * The daily AI cap in force for one person (L1b), and why it differs from what
 * the admin set: null when their box hasn't reported one.
 */
export function capLine(
  person: { cap_in_force?: number | null; cap_source?: "local" | "workspace" | null },
  setCap: number | null,
): string | null {
  const applied = person.cap_in_force ?? null;
  if (applied === null) return null;
  const n = applied.toLocaleString("en");
  if (setCap === null || applied === setCap) return `${n} a day`;
  if (person.cap_source === "local") return `${n} applied: Switch's own limit is lower`;
  return applied > setCap ? `${n} applied: the lowest allowed` : `${n} applied: the highest allowed`;
}

/** Awake hours as the page shows them: "41.5 h". */
export function hoursLabel(hours: number): string {
  return `${hours.toFixed(1)} h`;
}
