import type { UsageMetric } from "../../data/api";

const METRIC_LABELS: Record<UsageMetric, string> = {
  messages: "Messages",
  turns: "Turns",
  input_tokens: "Input tokens",
  output_tokens: "Output tokens",
  cache_read_tokens: "Cache read tokens",
  cache_write_tokens: "Cache write tokens",
};

export function metricLabel(metric: UsageMetric): string {
  return METRIC_LABELS[metric];
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
