import { describe, expect, it } from 'vitest';
import {
  agentProviderConfig,
  attributesFromProviderConfig,
  providerConfigFromAttributes,
  toSwitchSpecialization,
} from './agent-provider-config';

describe('agentProviderConfig schema', () => {
  it('parses a versioned config and rejects an unversioned one', () => {
    const ok = agentProviderConfig.safeParse({ version: '1', model: 'gpt-5.6-terra' });
    expect(ok).toEqual({ status: 'ok', data: { version: '1', model: 'gpt-5.6-terra' } });

    expect(agentProviderConfig.safeParse({ model: 'x' }).status).not.toBe('ok');
  });
});

describe('toSwitchSpecialization', () => {
  it('passes every stored setting through under the key the profile writer reads', () => {
    expect(
      toSwitchSpecialization({
        version: '1',
        model: 'o3',
        effort: 'high',
        verbosity: 'low',
        reasoningSummary: 'concise',
        webSearch: 'true',
        instructions: 'be terse',
      })
    ).toEqual({
      model: 'o3',
      effort: 'high',
      verbosity: 'low',
      reasoningSummary: 'concise',
      webSearch: 'true',
      instructions: 'be terse',
    });
  });

  it('drops empty/whitespace fields so the base default stands', () => {
    expect(
      toSwitchSpecialization({ version: '1', model: '  ', effort: '', instructions: 'x' })
    ).toEqual({ instructions: 'x' });
  });

  it('returns undefined when nothing is set or the config is absent', () => {
    expect(toSwitchSpecialization(null)).toBeUndefined();
    expect(toSwitchSpecialization(undefined)).toBeUndefined();
    expect(toSwitchSpecialization({ version: '1' })).toBeUndefined();
    expect(toSwitchSpecialization({ version: '1', model: '   ' })).toBeUndefined();
  });
});

describe('form attributes ↔ stored config', () => {
  it('round-trips every setting', () => {
    const config = {
      version: '1' as const,
      model: 'o3',
      effort: 'none',
      verbosity: 'high',
      reasoningSummary: 'detailed',
      webSearch: 'false',
      instructions: 'be terse',
    };

    expect(providerConfigFromAttributes(attributesFromProviderConfig(config))).toEqual(config);
  });

  it('seeds a blank form from no config, and reads it back as nothing set', () => {
    const attributes = attributesFromProviderConfig(null);

    expect(attributes).toEqual({
      model: '',
      effort: '',
      verbosity: '',
      reasoningSummary: '',
      webSearch: '',
      instructions: '',
    });
    expect(providerConfigFromAttributes(attributes)).toBeNull();
  });

  it('keeps web search off as a stored value — unset and off are different', () => {
    expect(providerConfigFromAttributes({ webSearch: 'false' })).toEqual({
      version: '1',
      webSearch: 'false',
    });
    expect(providerConfigFromAttributes({ webSearch: '' })).toBeNull();
  });
});
