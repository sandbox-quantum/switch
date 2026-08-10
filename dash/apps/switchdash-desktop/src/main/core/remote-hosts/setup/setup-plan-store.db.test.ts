import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { remoteHostSetupPlans } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { getSetupPlan } = await import('./setup-plan-store');

/**
 * Plans written by a build that still had the automated run.
 *
 * These rows are on real machines. If the parser refused them, upgrading would
 * look like a corrupt database — so the removed states are mapped to their
 * nearest live meaning instead.
 */
describe('reading a plan written before the automated run was removed', () => {
  let close: (() => void) | undefined;

  beforeEach(async () => {
    const fixture = await openFixture('empty');
    mocks.db = fixture.db;
    close = fixture.close;
  });

  afterEach(() => {
    close?.();
    mocks.db = undefined;
  });

  async function insertLegacyPlan(status: string, stepState: string) {
    await mocks.db!.insert(remoteHostSetupPlans).values({
      sshHost: 'dev-vm',
      status,
      steps: JSON.stringify([
        {
          id: 'node',
          kind: 'core-dependency',
          name: 'Node.js',
          state: stepState,
          outcome: 'missing',
          version: null,
          error: null,
          output: null,
          optional: false,
          dependsOn: [],
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]),
      currentStepId: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  }

  it('reads a halted plan as idle rather than refusing to load it', async () => {
    await insertLegacyPlan('halted', 'failed');

    const plan = await getSetupPlan('dev-vm');

    expect(plan?.status).toBe('idle');
    expect(plan?.steps[0]!.state).toBe('failed');
  });

  it('reads a running plan as idle', async () => {
    await insertLegacyPlan('running', 'pending');

    expect((await getSetupPlan('dev-vm'))?.status).toBe('idle');
  });

  it('reads a blocked step as pending — "not unless upstream is fixed" is just "not yet" now', async () => {
    await insertLegacyPlan('halted', 'blocked');

    const plan = await getSetupPlan('dev-vm');

    expect(plan?.steps[0]!.state).toBe('pending');
    // The observation itself is still good; only the state vocabulary changed.
    expect(plan?.steps[0]!.outcome).toBe('missing');
  });

  it('still refuses a value that was never valid', async () => {
    await insertLegacyPlan('nonsense', 'pending');

    await expect(getSetupPlan('dev-vm')).rejects.toThrow(/Invalid plan status/);
  });
});
