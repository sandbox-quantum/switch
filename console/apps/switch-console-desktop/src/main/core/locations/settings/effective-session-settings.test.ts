import { describe, expect, it, vi } from 'vitest';
import type { FileSystemProvider } from '@main/core/fs/types';
import { getEffectiveSessionSettings } from './effective-session-settings';
import type { LocationSettingsProvider } from './provider';

function makeLocationSettings(settings: Awaited<ReturnType<LocationSettingsProvider['get']>>) {
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
  it('merges shareable location settings by leaf with location settings winning', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeLocationSettings({
        scripts: { run: 'pnpm dev' },
      }),
      sessionFs: makeSessionFs({
        scripts: { setup: 'pnpm install', run: 'npm run dev' },
        shellSetup: 'source .envrc',
        autoRunSetupScriptOnSessionCreation: true,
        remote: 'upstream',
      }),
    });

    expect(settings).toMatchObject({
      shellSetup: 'source .envrc',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });
    expect(settings).not.toHaveProperty('autoRunSetupScriptOnSessionCreation');
    expect(settings).not.toHaveProperty('remote');
    expect(settings).not.toHaveProperty('baseRemote');
  });

  it('falls back to location settings when the session config is invalid', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeLocationSettings({ shellSetup: 'nvm use' }),
      sessionFs: {
        exists: vi.fn().mockResolvedValue(true),
        read: vi.fn().mockResolvedValue({ content: '{', truncated: false, totalSize: 1 }),
      } as unknown as FileSystemProvider,
    });

    expect(settings).toEqual({ shellSetup: 'nvm use' });
  });

  it('ignores location settings that fail to parse', async () => {
    const settings = await getEffectiveSessionSettings({
      locationSettings: makeLocationSettings({
        shellSetup: 42,
      } as never),
      sessionFs: makeSessionFs(null),
    });

    expect(settings).toEqual({});
  });
});
