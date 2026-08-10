/**
 * Migration 0046 — adds the `remote_host_setup_plans` table (CHOO-1809), which
 * persists a remote host's onboarding run so it can be resumed after a restart.
 * Applies all migrations on a fresh schema and asserts the table exists and
 * round-trips a plan, including a halted one with its failure detail intact —
 * the case the table exists for.
 */

import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { remoteHostSetupPlans } from '@main/db/schema';

describe('migration 0046: remote host setup plans', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('creates the remote_host_setup_plans table with the expected columns', async () => {
    fixture = await openFixture('empty');

    const columns = fixture.sqlite
      .prepare(`PRAGMA table_info('remote_host_setup_plans')`)
      .all() as { name: string }[];
    const columnNames = columns.map((c) => c.name);

    expect(columnNames).toContain('ssh_host');
    expect(columnNames).toContain('status');
    expect(columnNames).toContain('steps');
    expect(columnNames).toContain('current_step_id');
    expect(columnNames).toContain('created_at');
    expect(columnNames).toContain('updated_at');
  });

  it('defaults a new plan to idle', async () => {
    fixture = await openFixture('empty');

    await fixture.db.insert(remoteHostSetupPlans).values({ sshHost: 'dev-vm', steps: '[]' });

    const [row] = await fixture.db
      .select()
      .from(remoteHostSetupPlans)
      .where(eq(remoteHostSetupPlans.sshHost, 'dev-vm'));

    expect(row!.status).toBe('idle');
    expect(row!.currentStepId).toBeNull();
  });

  it('round-trips a halted plan with its failure detail', async () => {
    fixture = await openFixture('empty');
    const steps = JSON.stringify([
      { id: 'git', kind: 'core-dependency', state: 'satisfied', outcome: 'satisfied' },
      {
        id: 'node',
        kind: 'core-dependency',
        state: 'failed',
        outcome: 'missing',
        error: 'apt-get failed',
        output: 'E: Unable to locate package',
      },
      { id: 'tmux', kind: 'core-dependency', state: 'blocked', outcome: null },
    ]);

    await fixture.db.insert(remoteHostSetupPlans).values({
      sshHost: 'dev-vm',
      status: 'halted',
      steps,
      currentStepId: 'node',
    });

    const [row] = await fixture.db
      .select()
      .from(remoteHostSetupPlans)
      .where(eq(remoteHostSetupPlans.sshHost, 'dev-vm'));

    expect(row!.status).toBe('halted');
    expect(row!.currentStepId).toBe('node');
    const parsed = JSON.parse(row!.steps) as { id: string; state: string; output?: string }[];
    expect(parsed.map((s) => s.state)).toEqual(['satisfied', 'failed', 'blocked']);
    expect(parsed[1]!.output).toBe('E: Unable to locate package');
  });

  it('keeps one plan per host', async () => {
    fixture = await openFixture('empty');

    await fixture.db.insert(remoteHostSetupPlans).values({ sshHost: 'dev-vm', steps: '[]' });

    await expect(
      fixture.db.insert(remoteHostSetupPlans).values({ sshHost: 'dev-vm', steps: '[]' })
    ).rejects.toThrow();
  });
});
