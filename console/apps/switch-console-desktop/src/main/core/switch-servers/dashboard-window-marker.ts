import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * Whether the sessions the old in-app dashboard windows kept have been
 * cleared on this install. Dashboard pages open in the browser now, so no
 * window makes one again and the clearing runs until it has once succeeded
 * for every partition on disk (`clearDashboardWindowSessions`).
 */
const MARKER_KEY = 'dashboardWindowSessionsCleared';

export async function dashboardWindowSessionsCleared(): Promise<boolean> {
  const [row] = await db.select().from(kv).where(eq(kv.key, MARKER_KEY)).limit(1);
  return row?.value === '1';
}

export async function markDashboardWindowSessionsCleared(): Promise<void> {
  await db
    .insert(kv)
    .values({ key: MARKER_KEY, value: '1', updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoUpdate({ target: kv.key, set: { value: '1', updatedAt: sql`CURRENT_TIMESTAMP` } });
}
