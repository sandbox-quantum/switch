import { openFixture } from '@tooling/utils/db';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';
import { deployerIdentity } from './deployer-identity';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const DEPLOYER_ID_KEY = 'sidecarDeployerId';

describe('deployerIdentity', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('mints an id on first use and keeps it', async () => {
    const first = await deployerIdentity();
    expect(first).not.toBe('');
    expect(await deployerIdentity()).toBe(first);
  });

  it('persists exactly one row rather than re-minting per call', async () => {
    // A different id every launch would be worse than none: this install would
    // read its own previous sidecar as another install's and never upgrade it.
    await deployerIdentity();
    await deployerIdentity();
    expect(await fixture.db.select().from(kv).where(eq(kv.key, DEPLOYER_ID_KEY))).toHaveLength(1);
  });

  it('returns one shared id when concurrent callers race to mint', async () => {
    const [a, b, c] = await Promise.all([
      deployerIdentity(),
      deployerIdentity(),
      deployerIdentity(),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('keeps the id an earlier run already stored', async () => {
    await fixture.db
      .insert(kv)
      .values({ key: DEPLOYER_ID_KEY, value: 'minted-earlier', updatedAt: sql`CURRENT_TIMESTAMP` });

    expect(await deployerIdentity()).toBe('minted-earlier');
  });

  it('is unique per install', async () => {
    const mine = await deployerIdentity();

    const other = await openFixture('empty');
    mocks.db = other.db;
    try {
      expect(await deployerIdentity()).not.toBe(mine);
    } finally {
      other.close();
    }
  });
});
