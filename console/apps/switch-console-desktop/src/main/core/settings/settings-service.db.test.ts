import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { appSettings } from '@main/db/schema';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const { SettingsStore } = await import('./settings-service');

let fixture: Awaited<ReturnType<typeof openFixture>>;

beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
});

afterEach(() => {
  mocks.db = undefined;
  fixture.close();
});

it('loads an install that still holds a settings group this version no longer has', async () => {
  // Older versions stored `onboarding.showChecklist` for the sidebar setup
  // checklist, which has since been removed along with its setting.
  await fixture.db
    .insert(appSettings)
    .values([
      { key: 'onboarding', value: JSON.stringify({ showChecklist: false }) },
      { key: 'theme', value: JSON.stringify('emdark') },
    ])
    .execute();

  const settings = await new SettingsStore().getAll();

  expect(settings.theme).toBe('emdark');
  expect(settings).not.toHaveProperty('onboarding');
});
