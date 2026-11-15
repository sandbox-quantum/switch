import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * What changing a setting reports — and, for one setting, what it deliberately
 * does not.
 */

const { h } = vi.hoisted(() => ({
  h: {
    trackEvent: vi.fn(),
    trackBackgroundEvent: vi.fn(),
    launchInstallKind: vi.fn(),
    get: vi.fn(),
    getWithMeta: vi.fn(),
    update: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    resetField: vi.fn(async () => {}),
  },
}));

vi.mock('@main/core/telemetry/telemetry-service', () => ({
  trackEvent: h.trackEvent,
  trackBackgroundEvent: h.trackBackgroundEvent,
}));
vi.mock('@main/core/telemetry/launch-history', () => ({
  launchInstallKind: h.launchInstallKind,
}));
vi.mock('./settings-service', () => ({
  appSettingsService: {
    get: h.get,
    update: h.update,
    getAll: vi.fn(),
    getWithMeta: h.getWithMeta,
    reset: h.reset,
    resetField: h.resetField,
  },
}));

const { appSettingsController } = await import('./controller');

const NEVER_ASKED = { enabled: false, askedAt: null };

/** The consent report waits for the launch kind, so it lands after `update` returns. */
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset rather than cleared: a read a test queued and the code never made
  // must not answer the next test's.
  h.get.mockReset();
  h.get.mockResolvedValue(NEVER_ASKED);
  h.launchInstallKind.mockResolvedValue('new');
});

/** What the store holds for a setting before a write, and after it. */
function stored(before: unknown, after: unknown): void {
  h.get.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
}

describe('changing a setting', () => {
  it('reports which setting changed, and never its value', async () => {
    const value = { defaultLocationsDirectory: '/Users/someone/secret-project/font.ttf' };
    stored({ defaultLocationsDirectory: '' }, value);

    await appSettingsController.update('localLocation', value as never);
    await settled();

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'localLocation' });
    expect(JSON.stringify(h.trackEvent.mock.calls)).not.toContain('secret-project');
  });

  it('says nothing when the write leaves the setting as it was', async () => {
    // Picking the app that is already the default, or saving a form unchanged,
    // is not someone changing a setting.
    stored({ default: 'vscode' }, { default: 'vscode' });

    await appSettingsController.update('openIn', { default: 'vscode' } as never);
    await settled();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it.each(['telemetry', 'onboarding'] as const)(
    'never reports %s, which the app writes as it goes',
    async (key) => {
      // Every read differs, so only leaving the key out keeps this quiet.
      let reads = 0;
      h.get.mockImplementation(async () => ({ enabled: false, askedAt: null, reads: ++reads }));

      await appSettingsController.update(key, { showChecklist: false } as never);
      await settled();

      expect(h.trackEvent.mock.calls.map(([name]) => name)).not.toContain('setting_changed');
    }
  );

  it('says nothing, and still saves, when the setting cannot be read back', async () => {
    h.get.mockResolvedValueOnce({ default: 'vscode' }).mockRejectedValueOnce(new Error('locked'));

    await appSettingsController.update('openIn', { default: 'cursor' } as never);
    await settled();

    expect(h.update).toHaveBeenCalled();
    expect(h.trackEvent).not.toHaveBeenCalled();
  });
});

describe('reading a setting', () => {
  it('passes the value, its defaults and its overrides through, and reports nothing', async () => {
    const meta = {
      value: { defaultLocationsDirectory: '/srv/agents' },
      defaults: { defaultLocationsDirectory: '' },
      overrides: { defaultLocationsDirectory: '/srv/agents' },
    };
    h.getWithMeta.mockResolvedValue(meta);

    expect(await appSettingsController.getWithMeta('localLocation')).toBe(meta);
    expect(h.getWithMeta).toHaveBeenCalledWith('localLocation');
    expect(h.trackEvent).not.toHaveBeenCalled();
  });
});

describe('putting a setting back to its default', () => {
  it('reports a whole group being reset', async () => {
    stored({ defaultLocationsDirectory: '/srv/agents' }, { defaultLocationsDirectory: '' });

    await appSettingsController.reset('localLocation');
    await settled();

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'localLocation' });
  });

  it('says nothing for a reset of a setting already at its default', async () => {
    stored({ defaultLocationsDirectory: '' }, { defaultLocationsDirectory: '' });

    await appSettingsController.reset('localLocation');
    await settled();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it('reports one field being reset', async () => {
    // The Reset control sits in the same rows the editors do. Counting only the
    // change that set a preference makes every one somebody undid look like one
    // that stuck.
    stored({ defaultLocationsDirectory: '/srv/agents' }, { defaultLocationsDirectory: '' });

    await appSettingsController.resetField('localLocation', 'defaultLocationsDirectory');
    await settled();

    expect(h.trackEvent).toHaveBeenCalledWith('setting_changed', { setting_key: 'localLocation' });
  });

  it('says nothing when the reset did not happen', async () => {
    h.reset.mockRejectedValueOnce(new Error('database is locked'));

    await expect(appSettingsController.reset('localLocation')).rejects.toThrow();
    await settled();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });

  it('does not treat resetting telemetry as an agreement to share usage data', async () => {
    // The default is off and never-asked, so a reset can only ever land on the
    // answer that has nothing to report.
    await appSettingsController.reset('telemetry');
    await settled();

    expect(h.trackEvent).not.toHaveBeenCalled();
  });
});

describe('agreeing to share usage data', () => {
  it('reports an agreement given at the first-run prompt, as nobody using the app', async () => {
    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    // The notice records it as it is shown, so it is in no session.
    expect(h.trackBackgroundEvent).toHaveBeenCalledWith('telemetry_consent_changed', {
      source: 'first_run',
      install_kind: 'new',
    });
    expect(h.trackEvent).not.toHaveBeenCalledWith('telemetry_consent_changed', expect.anything());
  });

  it('reports one given later, in settings, as that', async () => {
    h.get.mockResolvedValue({ enabled: false, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    expect(h.trackEvent).toHaveBeenCalledWith('telemetry_consent_changed', {
      source: 'settings',
      install_kind: 'new',
    });
    expect(h.trackBackgroundEvent).not.toHaveBeenCalled();
  });

  it('says nothing when someone declines', async () => {
    // Not merely unreported — unreportable. The gate is read immediately before
    // every send, so this would be dropped anyway; the point is that we do not
    // try to transmit something from someone at the moment they said not to.
    await appSettingsController.update('telemetry', { enabled: false, askedAt: 1 } as never);
    await settled();

    const names = [...h.trackEvent.mock.calls, ...h.trackBackgroundEvent.mock.calls].map(
      ([name]) => name
    );
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('says nothing when consent is turned off again', async () => {
    h.get.mockResolvedValue({ enabled: true, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: false, askedAt: 1 } as never);
    await settled();

    const names = [...h.trackEvent.mock.calls, ...h.trackBackgroundEvent.mock.calls].map(
      ([name]) => name
    );
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('does not report a fresh agreement when nothing changed', async () => {
    // Re-saving an unrelated part of the settings must not look like someone
    // agreeing all over again.
    h.get.mockResolvedValue({ enabled: true, askedAt: 1 });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    const names = [...h.trackEvent.mock.calls, ...h.trackBackgroundEvent.mock.calls].map(
      ([name]) => name
    );
    expect(names).not.toContain('telemetry_consent_changed');
  });

  it('writes the setting before reporting, since the gate is read on the way out', async () => {
    const order: string[] = [];
    h.update.mockImplementation(async () => void order.push('write'));
    h.trackBackgroundEvent.mockImplementation((name: string) => {
      if (name === 'telemetry_consent_changed') order.push('report');
    });

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    expect(order).toEqual(['write', 'report']);
  });

  it('still saves telemetry when the previous answer cannot be read, and claims no agreement', async () => {
    // The read is only there to tell a first agreement from a later one. It
    // failing must never stop someone turning telemetry off.
    h.get.mockRejectedValue(new Error('database is locked'));

    await appSettingsController.update('telemetry', { enabled: false, askedAt: 1 } as never);
    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    expect(h.update).toHaveBeenCalledTimes(2);
    expect(h.trackEvent).not.toHaveBeenCalled();
    expect(h.trackBackgroundEvent).not.toHaveBeenCalled();
  });

  it('waits for the launch kind when the first-run notice is answered before boot records it', async () => {
    // Boot records the launch without waiting on it, so a slow database can let
    // someone answer first. Reading too early would send a kind nobody worked
    // out, on an event an install only ever sends once.
    let recorded: (kind: 'new') => void = () => {};
    h.launchInstallKind.mockReturnValue(new Promise((resolve) => (recorded = resolve)));

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    expect(h.update).toHaveBeenCalled();
    expect(h.trackBackgroundEvent).not.toHaveBeenCalled();

    recorded('new');
    await settled();

    expect(h.trackBackgroundEvent).toHaveBeenCalledWith('telemetry_consent_changed', {
      source: 'first_run',
      install_kind: 'new',
    });
  });

  it('reports the launch kind it is given, unknown included', async () => {
    h.launchInstallKind.mockResolvedValue('unknown');

    await appSettingsController.update('telemetry', { enabled: true, askedAt: 1 } as never);
    await settled();

    expect(h.trackBackgroundEvent).toHaveBeenCalledWith('telemetry_consent_changed', {
      source: 'first_run',
      install_kind: 'unknown',
    });
  });
});
