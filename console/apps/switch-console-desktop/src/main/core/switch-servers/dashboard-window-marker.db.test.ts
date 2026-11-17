import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import {
  dashboardWindowSessionsCleared,
  markDashboardWindowSessionsCleared,
} from './dashboard-window-marker';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const MARKER_KEY = 'dashboardWindowSessionsCleared';

describe('dashboard window sessions marker', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('reports not cleared on an install that has never cleared them', async () => {
    expect(await dashboardWindowSessionsCleared()).toBe(false);
  });

  it('reports cleared once a pass has marked it', async () => {
    await markDashboardWindowSessionsCleared();

    expect(await dashboardWindowSessionsCleared()).toBe(true);
  });

  it('marks it again in place rather than inserting a second row', async () => {
    await markDashboardWindowSessionsCleared();
    await markDashboardWindowSessionsCleared();

    expect(await dashboardWindowSessionsCleared()).toBe(true);
    expect(await fixture.db.select().from(kv).where(eq(kv.key, MARKER_KEY))).toHaveLength(1);
  });
});
