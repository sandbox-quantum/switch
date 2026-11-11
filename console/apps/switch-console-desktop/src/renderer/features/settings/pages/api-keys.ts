import { type ApiKeyLifetime, type SwitchApiKey } from '@shared/core/switch-servers/switch-servers';

/** Registration keys first, then agent keys; anything else is not the person's to manage here. */
export function splitApiKeys(keys: readonly SwitchApiKey[]): {
  registration: SwitchApiKey[];
  agent: SwitchApiKey[];
} {
  return {
    registration: keys.filter((key) => key.type === 'registration' || key.type === 'bootstrap'),
    agent: keys.filter((key) => key.type === 'agent'),
  };
}

/** The lifetimes a new registration key can have, as the gateway dashboard offers them. */
export const KEY_LIFETIMES = [
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'Never' },
] as const;

export type KeyLifetimeChoice = (typeof KEY_LIFETIMES)[number]['value'];

export const DEFAULT_KEY_LIFETIME: KeyLifetimeChoice = '90';

export const NEVER_EXPIRES_WARNING =
  'A key that never expires keeps working until you delete it, including if it leaks. Choose an expiry unless something depends on this key and cannot be given a new one.';

export function keyLifetime(choice: KeyLifetimeChoice): ApiKeyLifetime {
  return choice === 'never' ? 'never' : Number(choice);
}

/** A key's expiry for the list: its date, "Expired" and its date once past, or "No expiry". */
export function formatKeyExpiry(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return 'No expiry';
  const date = expiresAt.slice(0, 10);
  return new Date(expiresAt) <= now ? `Expired ${date}` : date;
}

/** The expiry line shown under a key just made. */
export function describeCreatedKeyExpiry(expiresAt: string | null): string {
  return expiresAt === null ? 'This key does not expire.' : `Expires ${expiresAt.slice(0, 10)}.`;
}
