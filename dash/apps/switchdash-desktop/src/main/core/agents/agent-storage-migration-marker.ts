import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * Persisted marker recording that the CHOO-1440 agent-storage migration has
 * completed a full, error-free pass. Once set, {@link migrateAgentStorage}
 * short-circuits at boot instead of re-opening every agent's workspace
 * filesystem (an SSH/SFTP round trip per remote agent) on every launch.
 */
const MARKER_KEY = 'agentStorageMigrationComplete';

/**
 * The migration generation this build knows how to satisfy. Bump it whenever
 * {@link migrateAgentStorage} learns to fix something it previously skipped, so
 * installs that latched an earlier generation run the new pass exactly once
 * instead of short-circuiting on a marker that no longer means what it says.
 *
 * - `1` — the original pass: Claude agents only (providers without a
 *   `repoAgents` behavior returned "complete" without being looked at).
 * - `2` — every provider's credentials collapsed onto the name-keyed key-space.
 */
const MARKER_VALUE = '2';

export async function isAgentStorageMigrationComplete(): Promise<boolean> {
  const [row] = await db.select().from(kv).where(eq(kv.key, MARKER_KEY)).limit(1);
  return row?.value === MARKER_VALUE;
}

export async function markAgentStorageMigrationComplete(): Promise<void> {
  await db
    .insert(kv)
    .values({ key: MARKER_KEY, value: MARKER_VALUE, updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoUpdate({
      target: kv.key,
      set: { value: MARKER_VALUE, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
}
