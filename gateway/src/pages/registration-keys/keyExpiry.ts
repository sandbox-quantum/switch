import { formatDate } from "../../theme/format";

/** How the key list shows when a key stops working. */
export function formatKeyExpiry(expiresAt: string | null, now: Date): string {
  if (expiresAt === null) return "No expiry";
  const formatted = formatDate(expiresAt);
  return new Date(expiresAt) <= now ? `Expired ${formatted}` : formatted;
}
