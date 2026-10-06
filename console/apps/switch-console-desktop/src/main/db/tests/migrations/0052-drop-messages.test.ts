import { openFixture } from '@tooling/utils/db';
import { expect, it } from 'vitest';

it('drops the messages table while keeping every session', async () => {
  const fixture = await openFixture('pre-0052');
  try {
    const tables = fixture.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')")
      .all() as { name: string }[];
    const names = tables.map((table) => table.name);
    expect(names).not.toContain('messages');
    expect(names).not.toContain('idx_messages_session_id');
    expect(names).not.toContain('idx_messages_timestamp');
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
