import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DecisionModelPreferenceFile, isDecisionModelRemoveReply } from './decision-model';

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'decision-model-'));
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('DecisionModelPreferenceFile', () => {
  it('is on with no file, and keeps what it is set to', async () => {
    const path = join(base, 'nested', 'decision-model.json');
    const preference = new DecisionModelPreferenceFile(() => path);
    expect(await preference.enabled()).toBe(true);
    await preference.setEnabled(false);
    expect(await preference.enabled()).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, enabled: false });
    await preference.setEnabled(true);
    expect(await new DecisionModelPreferenceFile(() => path).enabled()).toBe(true);
  });

  it('reads a file of another shape as on', async () => {
    const path = join(base, 'decision-model.json');
    writeFileSync(path, JSON.stringify({ version: 2, enabled: 'no' }));
    expect(await new DecisionModelPreferenceFile(() => path).enabled()).toBe(true);
  });
});

describe('isDecisionModelRemoveReply', () => {
  it('takes only the controller’s answer to a removal', () => {
    expect(
      isDecisionModelRemoveReply({ kind: 'switch-decision-model-removed', id: 'a', error: null })
    ).toBe(true);
    expect(isDecisionModelRemoveReply({ kind: 'switch-provider-rechecked', id: 'a' })).toBe(false);
    expect(isDecisionModelRemoveReply(null)).toBe(false);
  });
});
