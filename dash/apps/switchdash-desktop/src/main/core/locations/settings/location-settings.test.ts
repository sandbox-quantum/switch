import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRESERVE_PATTERNS } from '@shared/core/location-settings/location-settings';
import type { ProjectSettingsStorage } from './location-settings-storage';
import { LocalLocationSettingsProvider } from './providers/local-location-settings-provider';

const storageMockState = vi.hoisted(() => ({
  storage: undefined as ProjectSettingsStorage | undefined,
}));

function makeTrackingGit(isFileCleanlyTracked: boolean) {
  return {
    isFileCleanlyTracked: vi.fn().mockResolvedValue(isFileCleanlyTracked),
  };
}

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'project') return Promise.resolve({ tmuxByDefault: false });
      return Promise.resolve({
        defaultWorktreeDirectory: '/tmp/switchdash/worktrees',
      });
    }),
  },
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('./location-settings-storage', () => ({
  ProjectSettingsRepository: vi.fn(function ProjectSettingsRepository() {
    if (!storageMockState.storage) {
      throw new Error('ProjectSettingsRepository test storage was not configured');
    }
    return storageMockState.storage;
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

describe('LocationSettingsProvider worktreeDirectory validation', () => {
  const tempDirs: string[] = [];
  const createStorage = (): ProjectSettingsStorage => {
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

  const locationId = () => `project-${randomUUID()}`;

  beforeEach(() => {
    storageMockState.storage = createStorage();
  });

  afterEach(() => {
    storageMockState.storage = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds default preserve patterns when the repo has no shared config', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
    });
  });

  it('seeds default preserve patterns when shared config omits preservePatterns', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({ shellSetup: 'nvm use' })
    );

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
    });
  });

  it('does not seed default preserve patterns when shared config defines preservePatterns', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({ preservePatterns: ['.env.shared'] })
    );

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    await expect(provider.get()).resolves.not.toHaveProperty('preservePatterns');
  });

  it('migrates shareable settings from a local-only root config', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(
      path.join(rootPath, '.switchdash.json'),
      JSON.stringify({
        preservePatterns: ['.env.local'],
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
      preservePatterns: ['.env.local'],
      shellSetup: 'nvm use',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
        teardown: 'pnpm cleanup',
      },
    });
  });

  it('migrates local-only shareable settings for rows already base-migrated', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
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
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
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

    const result = await provider.update({ preservePatterns: [] });
    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('keeps cleanly tracked shareable settings file-backed', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
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

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
    });
    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('does not seed computed worktreeDirectory into project settings', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    await expect(provider.get()).resolves.not.toHaveProperty('worktreeDirectory');
    await expect(provider.getDefaultWorktreeDirectory()).resolves.toBe('/tmp/switchdash/worktrees');
    await expect(provider.getWorktreeDirectory()).resolves.toBe('/tmp/switchdash/worktrees');
  });

  it('keeps computed worktreeDirectory default separate from configured overrides', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const expectedOverridePath = path.resolve(rootPath, 'worktrees');
    const result = await provider.update({
      preservePatterns: [],
      worktreeDirectory: expectedOverridePath,
    });
    expect(result.success).toBe(true);

    const expectedOverride = fs.realpathSync(expectedOverridePath);
    await expect(provider.get()).resolves.toMatchObject({ worktreeDirectory: expectedOverride });
    await expect(provider.getDefaultWorktreeDirectory()).resolves.toBe('/tmp/switchdash/worktrees');
    await expect(provider.getWorktreeDirectory()).resolves.toBe(expectedOverride);
  });

  it('stores the selected GitHub account as base project settings', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    const result = await provider.update({
      preservePatterns: [],
      githubAccountId: 'github.com:42',
    });

    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.toMatchObject({ githubAccountId: 'github.com:42' });
  });

  it('stores null GitHub account selection as an explicit project override', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    const result = await provider.update({
      preservePatterns: [],
      githubAccountId: null,
    });

    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.toMatchObject({ githubAccountId: null });
  });

  it('patches the selected GitHub account without replacing other base settings', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const row = {
      baseSettingsJson: JSON.stringify({
        tmux: true,
      }),
      shareableSettingsJson: JSON.stringify({
        preservePatterns: ['.env.local'],
      }),
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    const result = await provider.patch({ githubAccountId: 'github.com:42' });

    expect(result.success).toBe(true);
    expect(JSON.parse(row.baseSettingsJson)).toEqual({
      githubAccountId: 'github.com:42',
      tmux: true,
    });
    await expect(provider.get()).resolves.toMatchObject({
      githubAccountId: 'github.com:42',
      preservePatterns: ['.env.local'],
      tmux: true,
    });
  });

  it('retries legacy config migration after a failed attempt', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const row = {
      baseSettingsJson: '{}',
      shareableSettingsJson: '{}',
      legacyConfigMigratedAt: null,
    };
    let updateAttempts = 0;
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
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

  it('clears shareable fields without validating base settings', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    const row = {
      baseSettingsJson: JSON.stringify({
        worktreeDirectory: path.join(rootPath, 'not-yet-created'),
      }),
      shareableSettingsJson: JSON.stringify({
        preservePatterns: ['.env'],
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      }),
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);

    const result = await provider.patch({
      clearShareableFields: ['preservePatterns', 'scripts.run'],
    });

    expect(result.success).toBe(true);
    expect(JSON.parse(row.shareableSettingsJson)).toEqual({
      scripts: {
        setup: 'pnpm install',
      },
    });
  });

  it('normalizes and canonicalizes local absolute worktreeDirectory on update', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const expectedPath = path.resolve(rootPath, 'worktrees');
    const result = await provider.update({ preservePatterns: [], worktreeDirectory: expectedPath });
    expect(result.success).toBe(true);

    expect(fs.existsSync(expectedPath)).toBe(true);

    await expect(provider.get()).resolves.toMatchObject({
      worktreeDirectory: fs.realpathSync(expectedPath),
    });
  });

  it('rejects local relative worktreeDirectory values', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const result = await provider.update({ preservePatterns: [], worktreeDirectory: 'worktrees' });

    expect(result).toEqual({
      success: false,
      error: { type: 'invalid-worktree-directory' },
    });
  });

  it('rejects foreign absolute worktreeDirectory values for local projects', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const foreignPath = process.platform === 'win32' ? '/tmp/worktrees' : 'C:\\worktrees';
    const result = await provider.update({ preservePatterns: [], worktreeDirectory: foreignPath });

    expect(result).toEqual({
      success: false,
      error: { type: 'invalid-worktree-directory' },
    });
  });

  it('surfaces local worktreeDirectory validation errors', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);
    fs.writeFileSync(path.join(rootPath, 'not-a-directory'), 'file');

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const result = await provider.update({
      preservePatterns: [],
      worktreeDirectory: path.join(rootPath, 'not-a-directory', 'worktrees'),
    });
    expect(result).toEqual({
      success: false,
      error: { type: 'invalid-worktree-directory' },
    });
  });

  it('clears blank local worktreeDirectory values', async () => {
    const rootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'switchdash-settings-local-'));
    tempDirs.push(rootPath);

    const provider = new LocalLocationSettingsProvider(locationId(), rootPath);
    const result = await provider.update({ preservePatterns: [], worktreeDirectory: '   ' });
    expect(result.success).toBe(true);

    await expect(provider.get()).resolves.not.toHaveProperty('worktreeDirectory');
  });
});
