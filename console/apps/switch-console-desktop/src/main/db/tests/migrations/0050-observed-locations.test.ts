import { openFixture } from '@tooling/utils/db';
import { expect, it } from 'vitest';

/**
 * 0050 marks the locations this Console only observes (CHOO-2893). Every
 * location that existed before is one this Console runs its agents in, so each
 * must come out of the migration unobserved and with no owner named.
 */
it('adds the observed marker, leaving every existing location run from here', async () => {
  const fixture = await openFixture('pre-0050');
  try {
    const columns = fixture.sqlite.prepare('PRAGMA table_info(locations)').all() as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[];
    const observed = columns.find((column) => column.name === 'observed');
    expect(observed).toMatchObject({ notnull: 1, dflt_value: 'false' });
    expect(columns.find((column) => column.name === 'observed_owner')).toMatchObject({
      notnull: 0,
    });

    const rows = fixture.sqlite
      .prepare('SELECT id, observed, observed_owner FROM locations')
      .all() as { id: string; observed: number; observed_owner: string | null }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.observed).toBe(0);
      expect(row.observed_owner).toBeNull();
    }
    expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    fixture.close();
  }
});
