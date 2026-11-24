export interface SubscriptionUsageWindow {
  id: string;
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  /** Unix milliseconds. */
  resetsAt: number | null;
}

export interface SubscriptionUsageBucket extends Omit<SubscriptionUsageWindow, 'id' | 'label'> {
  name: string;
  group?: string;
  unlimited?: boolean;
  remainingCount?: number;
  totalCount?: number;
}

export interface SubscriptionUsageCredit {
  unit: 'currency' | 'credits';
  enabled: boolean;
  balance?: number | null;
  spent?: number | null;
  limit?: number | null;
  currencyCode?: string;
  unlimited?: boolean;
  resetsAt?: number | null;
}

export type SubscriptionUsageStatus =
  | 'idle'
  | 'fetching'
  | 'ok'
  | 'unauthenticated'
  | 'unavailable'
  | 'error';

export type SubscriptionUsageSource = 'rpc' | 'cli' | 'oauth' | 'api';

export interface ProviderSubscriptionUsageResult {
  providerId: string;
  status: SubscriptionUsageStatus;
  source?: SubscriptionUsageSource;
  planLabel?: string | null;
  windows: SubscriptionUsageWindow[];
  buckets?: SubscriptionUsageBucket[];
  extraUsage?: SubscriptionUsageCredit | null;
  /** A fixed user-facing message, never raw provider output. */
  message?: string | null;
  updatedAt: number | null;
  retryAt?: number | null;
  /** Main-process only. */
  accountFingerprint?: string | null;
}

export type ProviderSubscriptionUsageSnapshot = Omit<
  ProviderSubscriptionUsageResult,
  'accountFingerprint'
> & {
  stale?: boolean;
  staleError?: string | null;
};

export interface SubscriptionUsageInput {
  binaryPath: string;
  cwd: string;
  env: Record<string, string>;
  signal: AbortSignal;
}

export type ReadSubscriptionUsage = (
  input: SubscriptionUsageInput
) => Promise<ProviderSubscriptionUsageResult>;

export function clampUsagePercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

export function normalizeUsageTimestamp(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value <= 0) return null;
  const millis = value < 1e12 ? value * 1_000 : value;
  return millis <= 8.64e15 ? millis : null;
}
