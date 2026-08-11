/**
 * Migration 0029 — adds the `remote_hosts` table (Switch Console remote host
 * connection management). A host is an onboarded `~/.ssh/config` alias; the
 * table stores no credentials. Applies all migrations on a fresh schema and
 * asserts the table exists and round-trips a row.
 */

import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteHosts } from '@main/db/schema';

describe('migration 0029: remote hosts', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates the remote_hosts table with the expected columns', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite.prepare(`PRAGMA table_info('remote_hosts')`).all() as {
      name: string;
    }[];
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain('ssh_host');
    expect(columnNames).toContain('name');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('updated_at');
  });

  it('round-trips an onboarded host keyed by ssh alias', async () => {
    fixture = await openFixture('empty');

    await fixture.db.insert(remoteHosts).values({ sshHost: 'dev-vm', name: 'Dev VM' });

    const [row] = await fixture.db
      .select()
      .from(remoteHosts)
      .where(eq(remoteHosts.sshHost, 'dev-vm'));

    expect(row).toBeDefined();
    expect(row!.name).toBe('Dev VM');
  });
});
