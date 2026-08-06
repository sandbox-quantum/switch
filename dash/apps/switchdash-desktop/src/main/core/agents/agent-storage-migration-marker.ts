import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * Persisted marker recording which generation of the CHOO-1440 agent-storage
 * migration has completed a full, error-free pass. Once current,
 * {@link migrateAgentStorage} short-circuits at boot instead of re-opening every
 * agent's workspace filesystem (an SSH/SFTP round trip per remote agent, and a
 * 20s connect timeout per unreachable host) on every launch.
 */
const MARKER_KEY = 'agentStorageMigrationComplete';

/**
 * Generations of the migration:
 *
 * - `1` — the original pass. Providers without a `repoAgents` behavior returned
 *   "complete" without being looked at, so only Claude agents were migrated.
 * - `2` — the credential collapse runs for every provider.
 *
 * Bump this whenever the migration learns to fix something it previously
 * skipped, so installs that latched an earlier generation run the new pass
 * exactly once instead of short-circuiting on a marker that no longer means what
 * it says. Then teach `migrateAgentStorage` which agents the new generation can
 * actually change, so the re-run does not re-open workspaces it cannot fix.
 */
export const AGENT_STORAGE_MIGRATION_GENERATION = 3;

/** The generation last completed on this install; 0 when it has never run. */
export async function completedAgentStorageMigrationGeneration(): Promise<number> {
  const [row] = await db.select().from(kv).where(eq(kv.key, MARKER_KEY)).limit(1);
  const generation = Number.parseInt(row?.value ?? '', 10);
  return Number.isFinite(generation) ? generation : 0;
}

export async function markAgentStorageMigrationComplete(): Promise<void> {
  const value = String(AGENT_STORAGE_MIGRATION_GENERATION);
  await db
    .insert(kv)
    .values({ key: MARKER_KEY, value, updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoUpdate({
      target: kv.key,
      set: { value, updatedAt: sql`CURRENT_TIMESTAMP` },
    });
}
