import { describe, expect, it } from 'vitest';
import {
  CODEX_CONFIG_FIELDS,
  codexConfigFromForm,
  codexFormFromConfig,
} from './codex-config-fields';

describe('codex config fields', () => {
  it('declares exactly the fields the stored config carries', () => {
    expect(CODEX_CONFIG_FIELDS.map((f) => f.key)).toEqual(['model', 'effort', 'instructions']);
  });

  it('assembles a config from a filled form', () => {
    expect(
      codexConfigFromForm({ model: 'gpt-5.6-terra', effort: 'high', instructions: 'Be careful.' })
    ).toEqual({
      version: '1',
      model: 'gpt-5.6-terra',
      effort: 'high',
      instructions: 'Be careful.',
    });
  });

  it('drops blank and whitespace-only fields so the base Codex default stands', () => {
    expect(
      codexConfigFromForm({ model: '  gpt-5.6-terra ', effort: '', instructions: '   ' })
    ).toEqual({
      version: '1',
      model: 'gpt-5.6-terra',
      effort: undefined,
      instructions: undefined,
    });
  });

  it('is null when nothing is set — no profile, and no --profile argv', () => {
    expect(codexConfigFromForm({ model: '', effort: '', instructions: '' })).toBeNull();
    expect(codexConfigFromForm({ model: '  ', effort: '', instructions: '\n' })).toBeNull();
  });

  it('seeds a form from a stored config', () => {
    expect(
      codexFormFromConfig({ version: '1', model: 'gpt-5.6-terra', instructions: 'Be careful.' })
    ).toEqual({ model: 'gpt-5.6-terra', effort: '', instructions: 'Be careful.' });
  });

  it('seeds an empty form from no config', () => {
    expect(codexFormFromConfig(null)).toEqual({ model: '', effort: '', instructions: '' });
  });

  it('round-trips a config through the form unchanged', () => {
    const config = {
      version: '1' as const,
      model: 'gpt-5.6-terra',
      effort: 'xhigh',
      instructions: 'Review only.',
    };
    expect(codexConfigFromForm(codexFormFromConfig(config))).toEqual(config);
  });
});
