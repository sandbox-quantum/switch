import { openFixture } from '@tooling/utils/db';
import { expect, it } from 'vitest';

it('drops the terminal shell column while keeping every session', async () => {
  const fixture = await openFixture('pre-0050');
  try {
    const columns = fixture.sqlite.prepare('PRAGMA table_info(sessions)').all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).not.toContain('shell_id');
    const rows = fixture.sqlite.prepare('SELECT id FROM sessions ORDER BY id').all() as {
      id: string;
    }[];
    expect(rows.map((row) => row.id)).toEqual([
      'aaaa0001-0000-0000-0000-000000000000',
      'aaaa0002-0000-0000-0000-000000000000',
      'aaaa0003-0000-0000-0000-000000000000',
      'bbbb0001-0000-0000-0000-000000000000',
    ]);
    expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    fixture.close();
  }
});
