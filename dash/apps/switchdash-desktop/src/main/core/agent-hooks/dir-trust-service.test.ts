import { describe, expect, it, vi } from 'vitest';

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: vi.fn() },
}));

import { DirTrustService } from './dir-trust-service';

function makeProvider() {
  return {
    maybeAutoTrustLocal: vi.fn().mockResolvedValue(undefined),
  };
}

describe('DirTrustService', () => {
  it('delegates local workspace trust to each provider', async () => {
    const first = makeProvider();
    const second = makeProvider();
    const service = new DirTrustService([first, second]);
    const args = {
      providerId: 'cursor' as const,
      cwd: '/tmp/worktree',
      homedir: '/home/local-user',
      force: true,
    };

    await service.maybeAutoTrustLocal(args);

    expect(first.maybeAutoTrustLocal).toHaveBeenCalledWith(args);
    expect(second.maybeAutoTrustLocal).toHaveBeenCalledWith(args);
  });
});
