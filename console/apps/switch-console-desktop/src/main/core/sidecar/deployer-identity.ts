import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * This install's deployer identity: who "my build" belongs to, independently of
 * the version string.
 *
 * A sidecar is deployed to a host, not published to it, and two Switch Console
 * installs sharing a host both deploy into the same directory. Version ordering
 * decides between them when their releases differ (CHOO-1937) — but two dev
 * builds of the SAME release differ only by content hash, and a hash says which
 * build, never whose. Without an identity each install reads the other's sidecar
 * as an upgrade and they trade it back and forth for as long as both are open.
 *
 * Random rather than derived from the machine, the user, or the install path:
 * this id is written to a host colleagues can read, and none of those are ours
 * to disclose. It identifies an install only by being different from every other
 * one.
 *
 * Minted on first use and kept for the life of the install's database. A reset
 * database mints a new one, which reads as a different install — the sidecar it
 * previously deployed then looks foreign and is left alone rather than replaced.
 * That is the safe direction to be wrong in, and Restart still forces it.
 */
const DEPLOYER_ID_KEY = 'sidecarDeployerId';

async function readDeployerId(): Promise<string | null> {
  const [row] = await db.select().from(kv).where(eq(kv.key, DEPLOYER_ID_KEY)).limit(1);
  const value = row?.value.trim();
  return value ? value : null;
}

/**
 * The id, minting and persisting one if this install has never had one.
 *
 * Deliberately un-cached in this process: it precedes SSH round trips that cost
 * orders of magnitude more than a local point-select, and a cache would need a
 * test-only way to clear it.
 *
 * Raises rather than falling back to a fresh id when it cannot be persisted. An
 * id that changes every launch is worse than no id at all: every launch would
 * see its own previous sidecar as another install's and refuse to upgrade it.
 */
export async function deployerIdentity(): Promise<string> {
  const existing = await readDeployerId();
  if (existing) return existing;

  // `onConflictDoNothing` then re-read, rather than an upsert: two concurrent
  // callers each mint a candidate and exactly one row survives, so both return
  // the same id instead of the second overwriting the first.
  await db
    .insert(kv)
    .values({ key: DEPLOYER_ID_KEY, value: randomUUID(), updatedAt: sql`CURRENT_TIMESTAMP` })
    .onConflictDoNothing();

  const settled = await readDeployerId();
  if (!settled) {
    throw new Error("sidecar: could not persist this install's deployer identity");
  }
  return settled;
}
