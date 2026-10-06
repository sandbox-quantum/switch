import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocationSettingsStorage } from './location-settings-storage';
import { LocalLocationSettingsProvider } from './providers/local-location-settings-provider';

const storageMockState = vi.hoisted(() => ({
  storage: undefined as LocationSettingsStorage | undefined,
}));

function makeTrackingGit(isFileCleanlyTracked: boolean) {
  return {
    isFileCleanlyTracked: vi.fn().mockResolvedValue(isFileCleanlyTracked),
  };
}

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('./location-settings-storage', () => ({
  LocationSettingsRepository: vi.fn(function LocationSettingsRepository() {
    if (!storageMockState.storage) {
      throw new Error('LocationSettingsRepository test storage was not configured');
    }
    return storageMockState.storage;
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

describe('LocationSettingsProvider', () => {
  const tempDirs: string[] = [];
  const createStorage = (): LocationSettingsStorage => {
    const rows = new Map<
      string,
      {
        baseSettingsJson: string;
        shareableSettingsJson: string;
        legacyConfigMigratedAt: string | null;
      }
    >();
    return {
      get: async (locationId) => rows.get(locationId),
      insertIfMissing: async (locationId, settings) => {
        if (!rows.has(locationId)) rows.set(locationId, settings);
      },
      update: async (locationId, settings) => {
        rows.set(locationId, { ...rows.get(locationId)!, ...settings });
      },
    };
  };

  const locationId = () => `location-${randomUUID()}`;

  beforeEach(() => {
    storageMockState.storage = createStorage();
  });

  afterEach(() => {
    storageMockState.storage = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('migrates shareable settings from a local-only root config', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
          teardown: 'pnpm cleanup',
        },
      })
    );

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath, {
      git: makeTrackingGit(false),
    });

    await expect(provider.get()).resolves.toMatchObject({
      shellSetup: 'nvm use',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
        teardown: 'pnpm cleanup',
      },
    });
  });

  it('migrates local-only shareable settings for rows already base-migrated', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      })
    );
    const row = {
      baseSettingsJson: JSON.stringify({ defaultBranch: 'main' }),
      shareableSettingsJson: '{}',
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: LocationSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_locationId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath, {
      git: makeTrackingGit(false),
    });

    await expect(provider.get()).resolves.toMatchObject({
      shellSetup: 'nvm use',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });

    const result = await provider.update({});
    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('keeps cleanly tracked shareable settings file-backed', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      })
    );

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath, {
      git: makeTrackingGit(true),
    });

    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('retries legacy config migration after a failed attempt', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-settings-local-'));
    tempDirs.push(rootPath);
    const row = {
      baseSettingsJson: '{}',
      shareableSettingsJson: '{}',
      legacyConfigMigratedAt: null,
    };
    let updateAttempts = 0;
    const settingsStorage: LocationSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_locationId, settings) => {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error('db write failed');
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    await expect(provider.ensure()).rejects.toThrow('db write failed');
    await expect(provider.ensure()).resolves.toBeUndefined();
    await expect(provider.ensure()).resolves.toBeUndefined();

    expect(updateAttempts).toBe(2);
  });

  it('loads stored settings and config files that still carry retired fields', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switch-console-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({
        preservePatterns: ['.env.local'],
        worktreeDirectory: '/tmp/worktrees',
        shellSetup: 'nvm use',
      })
    );
    const row = {
      baseSettingsJson: JSON.stringify({
        worktreeDirectory: path.join(rootPath, 'worktrees'),
        githubAccountId: 'github.com:42',
        locationProvider: { type: 'script', provisionCommand: 'up', terminateCommand: 'down' },
        autoRunSetupScriptOnSessionCreation: true,
      }),
      shareableSettingsJson: JSON.stringify({
        preservePatterns: ['.env'],
        scripts: { setup: 'pnpm install' },
      }),
      legacyConfigMigratedAt: null,
    };
    const settingsStorage: LocationSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_locationId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath, {
      git: makeTrackingGit(false),
    });

    await expect(provider.get()).resolves.toEqual({
      autoRunSetupScriptOnSessionCreation: true,
      shellSetup: 'nvm use',
      scripts: { setup: 'pnpm install' },
    });
  });
});
