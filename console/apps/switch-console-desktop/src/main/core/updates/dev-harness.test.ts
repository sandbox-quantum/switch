import { describe, expect, it, vi } from 'vitest';
import {
  FAKE_UPDATE_SCENARIOS,
  FakeUpdateDriver,
  type UpdateSignals,
  nextFakeVersion,
  readFakeDownloadDuration,
  readFakeUpdateScenario,
} from './dev-harness';

function makeSignals(): UpdateSignals & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    checking: vi.fn(() => void calls.push('checking')),
    available: vi.fn(() => void calls.push('available')),
    notAvailable: vi.fn(() => void calls.push('notAvailable')),
    progress: vi.fn(() => void calls.push('progress')),
    downloaded: vi.fn(() => void calls.push('downloaded')),
    failed: vi.fn(() => void calls.push('failed')),
  };
}

describe('readFakeUpdateScenario', () => {
  it('is off when the variable is absent or blank', () => {
    expect(readFakeUpdateScenario({})).toBeNull();
    expect(readFakeUpdateScenario({ SWITCHDASH_FAKE_UPDATE: '   ' })).toBeNull();
  });

  it('accepts every documented scenario', () => {
    for (const scenario of FAKE_UPDATE_SCENARIOS) {
      expect(readFakeUpdateScenario({ SWITCHDASH_FAKE_UPDATE: scenario })).toBe(scenario);
    }
  });

  it('rejects a typo loudly rather than falling back to a default', () => {
    expect(() => readFakeUpdateScenario({ SWITCHDASH_FAKE_UPDATE: 'availabel' })).toThrow(
      /not a known scenario/
    );
  });
});

describe('readFakeDownloadDuration', () => {
  it('defaults when unset', () => {
    expect(readFakeDownloadDuration({})).toBeGreaterThan(0);
  });

  it('rejects values that would make the harness misbehave', () => {
    expect(() => readFakeDownloadDuration({ SWITCHDASH_FAKE_UPDATE_MS: '0' })).toThrow();
    expect(() => readFakeDownloadDuration({ SWITCHDASH_FAKE_UPDATE_MS: '-5' })).toThrow();
    expect(() => readFakeDownloadDuration({ SWITCHDASH_FAKE_UPDATE_MS: 'soon' })).toThrow();
  });
});

describe('nextFakeVersion', () => {
  it('bumps the minor and resets the patch', () => {
    expect(nextFakeVersion('0.17.1')).toBe('0.18.0');
    expect(nextFakeVersion('1.2.3')).toBe('1.3.0');
  });

  it('still produces a newer-looking version from an unparseable one', () => {
    expect(nextFakeVersion('unknown')).toBe('99.0.0');
  });
});

describe('FakeUpdateDriver', () => {
  it('reports an available update on the happy path', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('available', signals, '0.18.0', 40);

    const info = await driver.check();

    expect(signals.calls).toEqual(['checking', 'available']);
    expect(info?.version).toBe('0.18.0');
  });

  it('drives progress to completion', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('available', signals, '0.18.0', 40);

    await driver.download();

    expect(signals.progress).toHaveBeenCalled();
    expect(signals.calls.at(-1)).toBe('downloaded');

    const lastProgress = vi.mocked(signals.progress).mock.lastCall?.[0];
    expect(lastProgress?.percent).toBe(100);
    expect(lastProgress?.transferred).toBe(lastProgress?.total);
  });

  it('throws part-way through the download-error scenario', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('download-error', signals, '0.18.0', 40);

    await expect(driver.download()).rejects.toThrow(/connection reset/);
    expect(signals.calls).not.toContain('downloaded');
  });

  it('signals a failed check', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('check-error', signals, '0.18.0', 40);

    expect(await driver.check()).toBeNull();
    expect(signals.calls).toEqual(['checking', 'failed']);
  });

  it('signals up-to-date', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('up-to-date', signals, '0.18.0', 40);

    expect(await driver.check()).toBeNull();
    expect(signals.calls).toEqual(['checking', 'notAvailable']);
  });

  it('stops emitting once disposed', async () => {
    const signals = makeSignals();
    const driver = new FakeUpdateDriver('available', signals, '0.18.0', 400);

    const pending = driver.download();
    driver.dispose();
    await pending;

    expect(signals.calls).not.toContain('downloaded');
  });
});
