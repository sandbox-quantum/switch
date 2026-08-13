import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn(),
  },
}));

import { appSettingsService } from '@main/core/settings/settings-service';
import { isTelemetryAllowed } from './consent';

describe('isTelemetryAllowed', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('allows sending once the user has been asked and left the toggle on', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ enabled: true, askedAt: 1_700_000_000 });
    await expect(isTelemetryAllowed()).resolves.toBe(true);
  });

  it('refuses on a fresh install that has not reached the prompt yet', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ enabled: true, askedAt: null });
    await expect(isTelemetryAllowed()).resolves.toBe(false);
  });

  it('refuses once the user has turned it off', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ enabled: false, askedAt: 1_700_000_000 });
    await expect(isTelemetryAllowed()).resolves.toBe(false);
  });

  it('refuses when the toggle is off and the prompt was never answered', async () => {
    vi.mocked(appSettingsService.get).mockResolvedValue({ enabled: false, askedAt: null });
    await expect(isTelemetryAllowed()).resolves.toBe(false);
  });
});
