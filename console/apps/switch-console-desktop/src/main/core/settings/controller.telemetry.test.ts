import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What changing a setting reports — and, for one setting, what it deliberately
 * does not.
 */

const { h } = vi.hoisted(() => ({
  h: {
    trackEvent: vi.fn(),
    get: vi.fn(),
    update: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    resetField: vi.fn(async () => {}),
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({ trackEvent: h.trackEvent }));
vi.mock('./settings-service', () => ({
  appSettingsService: {
    get: h.get,
    update: h.update,
    getAll: vi.fn(),
    getWithMeta: vi.fn(),
    reset: h.reset,
    resetField: h.resetField,
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

describe('putting a setting back to its default', () => {
  it('reports a whole group being reset', async () => {
    await appSettingsController.reset('terminal');

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'terminal' });
  });

  it('reports one field being reset', async () => {
    // The Reset control sits in the same rows the editors do. Counting only the
    // change that set a preference makes every one somebody undid look like one
    // that stuck.
    await appSettingsController.resetField('terminal', 'fontFamily');

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'terminal' });
  });

  it('says nothing when the reset did not happen', async () => {
    h.reset.mockRejectedValueOnce(new Error('database is locked'));

    await expect(appSettingsController.reset('terminal')).rejects.toThrow();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it('does not treat resetting telemetry as an agreement to share usage data', async () => {
    // The default is off and never-asked, so a reset can only ever land on the
    // answer that has nothing to report.
    await appSettingsController.reset('telemetry');

    const names = h.trackEvent.mock.calls.map(([name]) => name);
    expect(names).toEqual(['setting_changed']);
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
