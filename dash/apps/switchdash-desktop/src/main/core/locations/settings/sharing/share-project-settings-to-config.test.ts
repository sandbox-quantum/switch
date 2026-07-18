import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShareableLocationSettings } from '@shared/core/location-settings/location-settings';
import { computeLocationSettingsOverrideState } from './location-settings-override-state';
import {
  getLocationSettingsWriteTargets,
  resolveAllLocationSettingsTargets,
} from './location-settings-target-resolver';
import { shareLocationSettingsToConfig } from './share-location-settings-to-config';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  workspaceGet: vi.fn(),
  listForLocation: vi.fn(),
}));

vi.mock('@main/core/locations/location-runtime-registry', () => ({
  locationRuntimeRegistry: {
    get: mocks.workspaceGet,
    listForLocation: mocks.listForLocation,
  },
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: mocks.select,
  },
}));

vi.mock('../utils', () => ({
  resolveLocationRuntime: vi.fn().mockReturnValue(null),
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: vi.fn(),
  },
}));

describe('shareLocationSettingsToConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceGet.mockReturnValue(undefined);
    mocks.listForLocation.mockReturnValue([]);
  });

  it('writes selected shareable location settings to .switchdash.json', async () => {
    const write = vi.fn().mockResolvedValue({ success: true, bytesWritten: 100 });
    const patch = vi.fn().mockResolvedValue({ success: true });
    const location = {
      fs: {
        exists: vi.fn().mockResolvedValue(false),
        write,
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          defaultBranch: 'origin/main',
          baseRemote: 'origin',
          tmux: true,
          preservePatterns: ['.env', '.env.local'],
          shellSetup: 'nvm use',
          scripts: {
            setup: 'pnpm install',
            run: 'pnpm dev',
          },
        }),
        patch,
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns', 'shellSetup', 'scripts.setup', 'scripts.run'],
      },
      [{ type: 'location', label: 'Repo Name', path: '/repo', fs: location.fs as never }]
    );

    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith(
      '.switchdash.json',
      `${JSON.stringify(
        {
          preservePatterns: ['.env', '.env.local'],
          shellSetup: 'nvm use',
          scripts: {
            setup: 'pnpm install',
            run: 'pnpm dev',
          },
        },
        null,
        2
      )}\n`
    );
    expect(patch).toHaveBeenCalledWith({
      clearShareableFields: ['preservePatterns', 'shellSetup', 'scripts.setup', 'scripts.run'],
    });
  });

  it('preserves existing config fields when sharing a later script field to the same target', async () => {
    let configContent = '';
    let shareableSettings: ShareableLocationSettings = {
      preservePatterns: ['.env', '.env.local'],
    };
    const fs = {
      exists: vi.fn().mockImplementation(() => Promise.resolve(configContent !== '')),
      read: vi.fn().mockImplementation(() => Promise.resolve({ content: configContent })),
      write: vi.fn().mockImplementation((_path: string, content: string) => {
        configContent = content;
        return Promise.resolve({ success: true, bytesWritten: content.length });
      }),
    };
    const location = {
      fs,
      settings: {
        get: vi.fn().mockImplementation(() => Promise.resolve(shareableSettings)),
        patch: vi.fn().mockImplementation(({ clearShareableFields }) => {
          if (clearShareableFields.includes('preservePatterns')) {
            shareableSettings = {};
          }
          if (clearShareableFields.includes('scripts.run')) {
            shareableSettings = {};
          }
          return Promise.resolve({ success: true });
        }),
      },
    };
    const targets = [{ type: 'location' as const, label: 'Repo Name', path: '/repo', fs }];

    await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns'],
      },
      targets as never
    );

    shareableSettings = {
      scripts: {
        run: 'pnpm dev',
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['scripts.run'],
      },
      targets as never
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(configContent)).toEqual({
      preservePatterns: ['.env', '.env.local'],
      scripts: {
        run: 'pnpm dev',
      },
    });
  });

  it('only clears fields that were actually written to .switchdash.json', async () => {
    const write = vi.fn().mockResolvedValue({ success: true, bytesWritten: 100 });
    const patch = vi.fn().mockResolvedValue({ success: true });
    const location = {
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({
          content: JSON.stringify({ preservePatterns: ['.env'] }),
        }),
        write,
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env.local'],
        }),
        patch,
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns', 'scripts.run'],
      },
      [{ type: 'location', label: 'Repo Name', path: '/repo', fs: location.fs as never }]
    );

    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith(
      '.switchdash.json',
      `${JSON.stringify({ preservePatterns: ['.env.local'] }, null, 2)}\n`
    );
    expect(patch).toHaveBeenCalledWith({
      clearShareableFields: ['preservePatterns'],
    });
  });

  it('returns an error when the filesystem reports an unsuccessful write', async () => {
    const patch = vi.fn();
    const location = {
      fs: {
        exists: vi.fn().mockResolvedValue(false),
        write: vi.fn().mockResolvedValue({
          success: false,
          bytesWritten: 0,
          error: 'permission denied',
        }),
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
        patch,
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns'],
      },
      [{ type: 'location', label: 'Repo Name', path: '/repo', fs: location.fs as never }]
    );

    expect(result).toEqual({
      success: false,
      error: { type: 'write-config-failed', message: 'permission denied' },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('returns an error when clearing shared fields fails after writing config', async () => {
    const write = vi.fn().mockResolvedValue({ success: true, bytesWritten: 100 });
    const patch = vi.fn().mockResolvedValue({
      success: false,
      error: { type: 'error' },
    });
    const location = {
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({
          content: `${JSON.stringify({ shellSetup: 'old setup' }, null, 2)}\n`,
        }),
        write,
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
        patch,
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns'],
      },
      [{ type: 'location', label: 'Repo Name', path: '/repo', fs: location.fs as never }]
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Wrote .switchdash.json, but failed to clear shared location settings.',
      },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns the read/parse failure when existing .switchdash.json cannot be parsed', async () => {
    const location = {
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({ content: '{ invalid json' }),
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
      },
    };

    const result = await shareLocationSettingsToConfig(
      location as never,
      {
        target: { type: 'location' },
        fields: ['preservePatterns'],
      },
      [{ type: 'location', label: 'Repo Name', path: '/repo', fs: location.fs as never }]
    );

    if (result.success) {
      throw new Error('Expected write to fail');
    }
    expect(result.error).toMatchObject({
      type: 'write-config-failed',
    });
    if (result.error.type !== 'write-config-failed') {
      throw new Error(`Unexpected error type: ${result.error.type}`);
    }
    expect(result.error.message).toContain('Could not read existing .switchdash.json');
  });

  it('returns target resolution failures instead of rejecting the RPC', async () => {
    await expect(
      shareLocationSettingsToConfig(
        {
          settings: {
            get: vi.fn(),
          },
        } as never,
        {
          target: { type: 'session', sessionId: 'session-1' },
          fields: ['preservePatterns'],
        },
        []
      )
    ).resolves.toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Could not resolve the selected working copy.',
      },
    });
  });

  it('resolves only the location target and reads its override state', async () => {
    const locationRootFs = {
      exists: vi.fn().mockResolvedValue(true),
      read: vi.fn().mockResolvedValue({
        content: JSON.stringify({ shellSetup: 'root setup' }),
      }),
    };
    const location = {
      locationId: 'location-1',
      dir: '/repo',
      fs: locationRootFs,
      defaultWorkspaceType: { kind: 'local' },
    };
    mocks.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ name: 'Repo Name' }]),
        }),
      }),
    });

    const resolvedTargets = await resolveAllLocationSettingsTargets(location as never);
    const targets = getLocationSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeLocationSettingsOverrideState(resolvedTargets);

    expect(targets).toEqual([{ type: 'location', label: 'Repo Name', path: '/repo' }]);
    expect(overrideState.shellSetup).toEqual([
      { label: 'Repo Name', path: '/repo', value: 'root setup' },
    ]);
  });

  it('falls back to a default label when the location row no longer exists', async () => {
    const findBranchAnywhere = vi.fn();
    const location = {
      locationId: 'location-1',
      dir: '/repo',
      fs: {},
      defaultWorkspaceType: { kind: 'local' },
      worktreeService: {
        findBranchAnywhere,
      },
    };
    mocks.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([]),
        }),
      }),
    });

    const targets = getLocationSettingsWriteTargets(
      await resolveAllLocationSettingsTargets(location as never)
    );

    expect(targets).toEqual([{ type: 'location', label: 'Location repository', path: '/repo' }]);
    expect(mocks.select).toHaveBeenCalledTimes(1);
    expect(findBranchAnywhere).not.toHaveBeenCalled();
  });

  it('detects workspace setting overrides from .switchdash.json files', async () => {
    const location = {
      locationId: 'location-1',
      dir: '/repo',
      fs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({
          content: JSON.stringify({
            preservePatterns: ['.env', '.env.local'],
            shellSetup: 'nvm use',
            scripts: {
              setup: 'pnpm install',
              run: 'pnpm dev',
              teardown: 'docker compose down',
            },
          }),
        }),
      },
      defaultWorkspaceType: { kind: 'local' },
      worktreeService: {
        findBranchAnywhere: vi.fn(),
      },
    };
    mocks.select.mockReturnValueOnce({
      from: () => ({
        where: () => ({
          limit: vi.fn().mockResolvedValue([{ name: 'Repo Name' }]),
        }),
      }),
    });

    await expect(
      computeLocationSettingsOverrideState(
        await resolveAllLocationSettingsTargets(location as never)
      )
    ).resolves.toEqual({
      preservePatterns: [
        {
          label: 'Repo Name',
          path: '/repo',
          value: '.env\n.env.local',
        },
      ],
      shellSetup: [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'nvm use',
        },
      ],
      'scripts.setup': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'pnpm install',
        },
      ],
      'scripts.run': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'pnpm dev',
        },
      ],
      'scripts.teardown': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'docker compose down',
        },
      ],
    });
  });
});
