import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { locations, locationSettings } from '@main/db/schema';
import { countLocationsUsingGithubAccount } from './count-locations-using-github-account';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

const TARGET_ACCOUNT_ID = 'github.com:42';
const OTHER_ACCOUNT_ID = 'github.com:99';

function baseSettingsJson(githubAccountId?: string | null): string {
  const settings: Record<string, unknown> = {
    defaultBranch: 'main',
    baseRemote: 'origin',
  };
  if (githubAccountId !== undefined) {
    settings.githubAccountId = githubAccountId;
  }
  return JSON.stringify(settings);
}

describe('countLocationsUsingGithubAccount', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('counts only persisted locations pinned to the target account', async () => {
    await fixture.db.insert(locations).values([
      { id: 'loc-match-1', name: 'Match 1', sshHost: '', dir: '/repo/match-1' },
      { id: 'loc-match-2', name: 'Match 2', sshHost: '', dir: '/repo/match-2' },
      { id: 'loc-null', name: 'Null', sshHost: '', dir: '/repo/null' },
      { id: 'loc-other', name: 'Other', sshHost: '', dir: '/repo/other' },
      { id: 'loc-unconfigured', name: 'Unconfigured', sshHost: '', dir: '/repo/unconfigured' },
    ]);
    await fixture.db.insert(locationSettings).values([
      {
        locationId: 'loc-match-1',
        baseSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
      {
        locationId: 'loc-match-2',
        baseSettingsJson: baseSettingsJson(` ${TARGET_ACCOUNT_ID} `),
      },
      {
        locationId: 'loc-null',
        baseSettingsJson: baseSettingsJson(null),
      },
      {
        locationId: 'loc-other',
        baseSettingsJson: baseSettingsJson(OTHER_ACCOUNT_ID),
      },
      {
        locationId: 'loc-unconfigured',
        baseSettingsJson: baseSettingsJson(),
      },
    ]);

    await expect(countLocationsUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(2);
    await expect(countLocationsUsingGithubAccount(OTHER_ACCOUNT_ID)).resolves.toBe(1);
    await expect(countLocationsUsingGithubAccount('github.com:missing')).resolves.toBe(0);
  });

  it('skips malformed base settings JSON', async () => {
    await fixture.db.insert(locations).values([
      { id: 'loc-malformed', name: 'Malformed', sshHost: '', dir: '/repo/malformed' },
      { id: 'loc-valid', name: 'Valid', sshHost: '', dir: '/repo/valid' },
    ]);
    await fixture.db.insert(locationSettings).values([
      {
        locationId: 'loc-malformed',
        baseSettingsJson: '{not-json',
      },
      {
        locationId: 'loc-valid',
        baseSettingsJson: baseSettingsJson(TARGET_ACCOUNT_ID),
      },
    ]);

    await expect(countLocationsUsingGithubAccount(TARGET_ACCOUNT_ID)).resolves.toBe(1);
  });
});
