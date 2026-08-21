import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What changing a setting reports — and, for one setting, what it deliberately
 * does not.
 */

const { h } = vi.hoisted(() => ({
  h: { trackEvent: vi.fn(), get: vi.fn(), update: vi.fn(async () => {}) },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('./settings-service', () => ({
  appSettingsService: {
    get: h.get,
    update: h.update,
    getAll: vi.fn(),
    getWithMeta: vi.fn(),
    reset: vi.fn(),
    resetField: vi.fn(),
  },
}));

const { appSettingsController } = await import('./controller');

const NEVER_ASKED = { enabled: false, askedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  h.get.mockResolvedValue(NEVER_ASKED);
});

describe('changing a setting', () => {
  it('reports which setting changed, and never its value', async () => {
    await appSettingsController.update('terminal', {
      fontFamily: '/Users/someone/secret-project/font.ttf',
    } as never);

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'terminal' });
    expect(JSON.stringify(h.trackEvent.mock.calls)).not.toContain('secret-project');
  });
});

describe('agreeing to share usage data', () => {
  it('reports an agreement given at the first-run prompt', async () => {
    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);

    expect(h.trackEvent).toHaveBeenCalledWith('telemetry_consent_changed', {
      source: 'first_run',
    });
  });

  it('reports one given later, in settings, as that', async () => {
    h.get.mockResolvedValue({ enabled: false, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);

    expect(h.trackEvent).toHaveBeenCalledWith('telemetry_consent_changed', { source: 'settings' });
  });

  it('says nothing when someone declines', async () => {
    // Not merely unreported — unreportable. The gate is read immediately before
    // every send, so this would be dropped anyway; the point is that we do not
    // try to transmit something from someone at the moment they said not to.
    await appSettingsController.update('telemetry', { enabled: false, askedAt: 1 } as never);

    const names = h.trackEvent.mock.calls.map(([name]) => name);
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('says nothing when consent is turned off again', async () => {
    h.get.mockResolvedValue({ enabled: true, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: false, askedAt: 1 } as never);

    const names = h.trackEvent.mock.calls.map(([name]) => name);
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('does not report a fresh agreement when nothing changed', async () => {
    // Re-saving an unrelated part of the settings must not look like someone
    // agreeing all over again.
    h.get.mockResolvedValue({ enabled: true, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);

    const names = h.trackEvent.mock.calls.map(([name]) => name);
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('writes the setting before reporting, since the gate is read on the way out', async () => {
    const order: string[] = [];
    h.update.mockImplementation(async () => void order.push('write'));
    h.trackEvent.mockImplementation((name: string) => {
      if (name === 'telemetry_consent_changed') order.push('report');
    });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);

    expect(order).toEqual(['write', 'report']);
  });
});
