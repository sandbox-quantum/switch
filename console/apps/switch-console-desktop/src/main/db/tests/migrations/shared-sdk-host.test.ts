import { openFixture } from '@tooling/utils/db';
import { expect, it } from 'vitest';

it('removes the old execution marker while preserving sessions and native resume metadata', async () => {
  const fixture = await openFixture('pre-0048');
  try {
    const columns = fixture.sqlite.prepare('PRAGMA table_info(sessions)').all() as {
      name: string;
    }[];
    expect(columns.map((column) => column.name)).not.toContain('agent_session_id');
    const rows = fixture.sqlite.prepare('SELECT id, config FROM sessions ORDER BY id').all() as {
      id: string;
      config: string | null;
    }[];
    expect(rows).toHaveLength(4);
    expect(JSON.parse(rows[0].config!)).toEqual({ providerSessionId: 'native-conversation' });
    expect(fixture.sqlite.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  } finally {
    fixture.close();
  }
});
