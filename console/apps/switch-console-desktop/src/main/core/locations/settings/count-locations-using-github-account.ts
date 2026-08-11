import { db } from '@main/db/client';
import { locationSettings as locationSettingsTable } from '@main/db/schema';
import { parseJsonObject } from './location-settings-json';

function readPinnedGithubAccountId(raw: string): string | undefined {
  try {
    const parsed = parseJsonObject(raw) as Record<string, unknown>;
    const value = parsed.githubAccountId;
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function countLocationsUsingGithubAccount(accountId: string): Promise<number> {
  const targetAccountId = accountId.trim();
  if (!targetAccountId) return 0;

  const rows = db
    .select({ baseSettingsJson: locationSettingsTable.baseSettingsJson })
    .from(locationSettingsTable)
    .all();

  let count = 0;
  for (const row of rows) {
    if (readPinnedGithubAccountId(row.baseSettingsJson) === targetAccountId) {
      count += 1;
    }
  }
  return count;
}
