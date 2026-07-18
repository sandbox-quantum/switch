import { describe, expect, it, vi } from 'vitest';
import type { FileSystemProvider } from '@main/core/fs/types';
import { getEffectiveSessionSettings } from './effective-session-settings';
import type { LocationSettingsProvider } from './provider';

function makeProjectSettings(settings: Awaited<ReturnType<LocationSettingsProvider['get']>>) {
  return {
    get: vi.fn().mockResolvedValue(settings),
  } as unknown as LocationSettingsProvider;
}

function makeSessionFs(config: unknown | null): FileSystemProvider {
  return {
    exists: vi.fn().mockResolvedValue(config !== null),
    read: vi.fn().mockResolvedValue({
      content: JSON.stringify(config),
      truncated: false,
      totalSize: 0,
    }),
  } as unknown as FileSystemProvider;
}

describe('getEffectiveSessionSettings', () => {
  it('merges shareable project settings by leaf with project settings winning', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeProjectSettings({
        preservePatterns: ['.env.local'],
        scripts: { run: 'pnpm dev' },
      }),
      sessionFs: makeSessionFs({
        scripts: { setup: 'pnpm install', run: 'npm run dev' },
        shellSetup: 'source .envrc',
        tmux: true,
        remote: 'upstream',
      }),
    });

    expect(settings).toMatchObject({
      preservePatterns: ['.env.local'],
      shellSetup: 'source .envrc',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });
    expect(settings).not.toHaveProperty('tmux');
    expect(settings).not.toHaveProperty('remote');
    expect(settings).not.toHaveProperty('baseRemote');
  });

  it('falls back to defaults plus project settings when the session config is invalid', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeProjectSettings({ shellSetup: 'nvm use' }),
      sessionFs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({ content: '{', truncated: false, totalSize: 1 }),
      } as unknown as FileSystemProvider,
    });

    expect(settings.preservePatterns).toContain('.env');
    expect(settings.preservePatterns).not.toContain('.switchdash.json');
    expect(settings.shellSetup).toBe('nvm use');
  });

  it('falls back to defaults when project settings are invalid', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeProjectSettings({
        preservePatterns: 'not-an-array',
      } as never),
      sessionFs: makeSessionFs(null),
    });

    expect(settings.preservePatterns).toContain('.env');
  });
});
