import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../errors';
import {
  decisionLayout,
  decisionModelOverride,
  readLocalSetting,
  writeLocalSetting,
} from './local-setting';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-setting-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('decisionModelOverride', () => {
  it('reads SWITCH_CONTROLLER_DECISION_MODEL and --no-decision-model', () => {
    expect(decisionModelOverride(false, {})).toBeNull();
    expect(decisionModelOverride(false, { SWITCH_CONTROLLER_DECISION_MODEL: '' })).toBeNull();
    expect(decisionModelOverride(false, { SWITCH_CONTROLLER_DECISION_MODEL: 'on' })).toBe('on');
    expect(decisionModelOverride(false, { SWITCH_CONTROLLER_DECISION_MODEL: ' OFF ' })).toBe('off');
    expect(decisionModelOverride(true, {})).toBe('off');
    expect(decisionModelOverride(true, { SWITCH_CONTROLLER_DECISION_MODEL: 'on' })).toBe('off');
  });

  it('refuses any other value as a configuration error', () => {
    expect(() =>
      decisionModelOverride(false, { SWITCH_CONTROLLER_DECISION_MODEL: 'maybe' })
    ).toThrow(ConfigurationError);
  });
});

describe('the owner’s switch in the data directory', () => {
  it('is on until turned off, and keeps what was written', async () => {
    const layout = decisionLayout(dir);
    expect(await readLocalSetting(layout)).toEqual({ enabled: true, problem: null });
    await writeLocalSetting(layout, false);
    expect(await readLocalSetting(layout)).toEqual({ enabled: false, problem: null });
    await writeLocalSetting(layout, true);
    expect(await readLocalSetting(layout)).toEqual({ enabled: true, problem: null });
  });

  it('reads a file it cannot make sense of as off, and says why', async () => {
    const layout = decisionLayout(dir);
    mkdirSync(layout.root, { recursive: true });
    writeFileSync(layout.settings, 'not json');
    const setting = await readLocalSetting(layout);
    expect(setting.enabled).toBe(false);
    expect(setting.problem).toContain('settings.json');
  });
});
