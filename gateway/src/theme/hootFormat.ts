/* Formatting conventions from the Hoot design system's DESIGN.md.
 * Dates (§1), numbers (§3), empty states (§6) and identifiers (§9) are
 * prescriptive there — these helpers are the single place they're applied. */

/** Missing values render as a muted em-dash, never "N/A" and never a blank. */
export const EM_DASH = "—";

const pad = (n: number) => String(n).padStart(2, "0");

const parse = (value: string | number | Date | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** `2026-07-02` — unambiguous and sortable. Use in tables and filters, where
 *  scannability and column alignment matter more than the exact minute. */
export function formatDate(value: string | number | Date | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** `2026-07-02 9:23 AM` — the `YYYY-MM-DD` order is kept even though the time
 *  carries AM/PM. Use in detail views and anywhere precise metadata is the point. */
export function formatDateTime(value: string | number | Date | null | undefined): string {
  const date = parse(value);
  if (!date) return EM_DASH;
  const hours = date.getHours();
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${formatDate(date)} ${hour12}:${pad(date.getMinutes())} ${suffix}`;
}

/** Recency ladder: `Just now`, `N min ago`, `N hr ago`, `N days ago`, then a
 *  short absolute date once something is more than a week old. Always pair with
 *  the full absolute timestamp on hover — see `absoluteTitle`. */
export function formatRelative(value: string | number | Date | null | undefined): string {
  const date = parse(value);
  if (!date) return "Never";

  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 0) return formatDate(date);
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} ${days === 1 ? "day" : "days"} ago`;

  return formatDate(date);
}

/** The absolute timestamp that every relative time reveals on hover. */
export const absoluteTitle = (value: string | number | Date | null | undefined): string =>
  formatDateTime(value);

/** Thousands separators below 1,000; `1.5k` / `2.4M` above, for glanceable spots. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return EM_DASH;
  if (Math.abs(value) < 1000) return value.toLocaleString("en-US");
  if (Math.abs(value) < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** Match the noun to the number: `1 issue`, `3 issues`, and explicit zero copy. */
export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  if (count === 0) return `No ${plural}`;
  return `${count.toLocaleString("en-US")} ${count === 1 ? singular : plural}`;
}

/** Raw enum values never reach the UI; every status carries one canonical label. */
export const CHANNEL_TYPE_LABELS: Record<string, string> = {
  channel_public: "Public channel",
  channel_private: "Private channel",
  direct: "Direct message",
};

export const channelTypeLabel = (value: string | null | undefined): string =>
  value ? (CHANNEL_TYPE_LABELS[value] ?? titleCase(value)) : EM_DASH;

/** `session_addressable` -> `Session Addressable`. Status labels are Title Case. */
export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Identifiers, hashes, IPs and code render in monospace — character-level
 *  precision is the point. Spread onto an `sx`. */
export const MONO_SX = {
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: "0.8125rem",
} as const;

/** Numeric cells line up. */
export const TABULAR_SX = { fontVariantNumeric: "tabular-nums" } as const;
