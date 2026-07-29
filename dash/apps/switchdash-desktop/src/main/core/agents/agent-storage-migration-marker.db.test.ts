import { openFixture } from '@tooling/utils/db';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import {
  isAgentStorageMigrationComplete,
  markAgentStorageMigrationComplete,
} from './agent-storage-migration-marker';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const MARKER_KEY = 'agentStorageMigrationComplete';

describe('agent storage migration marker', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('reports incomplete when no marker has been written', async () => {
    expect(await isAgentStorageMigrationComplete()).toBe(false);
  });

  it('reports complete after a clean pass latches it', async () => {
    await markAgentStorageMigrationComplete();
    expect(await isAgentStorageMigrationComplete()).toBe(true);
  });

  it('reports incomplete for a marker latched by an earlier migration generation', async () => {
    // Generation 1 skipped every provider without a `repoAgents` behavior. An
    // install that latched it must still run the broadened pass, or the change
    // that broadened it does nothing at all for existing users.
    await fixture.db
      .insert(kv)
      .values({ key: MARKER_KEY, value: '1', updatedAt: sql`CURRENT_TIMESTAMP` });

    expect(await isAgentStorageMigrationComplete()).toBe(false);
  });

  it('upgrades a stale marker in place rather than inserting a second row', async () => {
    await fixture.db
      .insert(kv)
      .values({ key: MARKER_KEY, value: '1', updatedAt: sql`CURRENT_TIMESTAMP` });

    await markAgentStorageMigrationComplete();

    expect(await isAgentStorageMigrationComplete()).toBe(true);
    expect(await fixture.db.select().from(kv).where(eq(kv.key, MARKER_KEY))).toHaveLength(1);
  });
});
