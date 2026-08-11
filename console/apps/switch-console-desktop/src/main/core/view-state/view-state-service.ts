import { sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';

const viewStateKV = new KV<Record<string, unknown>>('view-state');

export const viewStateService = {
  save: (key: string, snapshot: unknown): Promise<void> => viewStateKV.set(key, snapshot),

  get: (key: string): Promise<unknown> => viewStateKV.get(key),

  getAll: (): Promise<Record<string, unknown>> =>
    viewStateKV.getAll() as Promise<Record<string, unknown>>,

  del: (key: string): Promise<void> => viewStateKV.del(key),

  reset: (): Promise<void> => viewStateKV.clear(),

  pruneOrphans: (): void => {
    db.run(
      sql`DELETE FROM kv WHERE key LIKE 'view-state:session:%' AND SUBSTR(key, LENGTH('view-state:session:') + 1) NOT IN (SELECT id FROM sessions)`
    );
    db.run(
      sql`DELETE FROM kv WHERE key LIKE 'view-state:location:%' AND SUBSTR(key, LENGTH('view-state:location:') + 1) NOT IN (SELECT id FROM locations)`
    );
  },
};
