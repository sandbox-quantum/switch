import { describe, expect, it } from 'vitest';
import {
  agentProviderConfig,
  attributesFromProviderConfig,
  providerConfigFromAttributes,
  toSwitchSpecialization,
} from './agent-provider-config';

describe('agentProviderConfig schema', () => {
  it('parses a versioned config and rejects an unversioned one', () => {
    const config = { version: '2', providerId: 'codex', values: { model: 'gpt-5.6-terra' } };
    expect(agentProviderConfig.safeParse(config)).toEqual({ status: 'ok', data: config });

    expect(agentProviderConfig.safeParse({ values: { model: 'x' } }).status).not.toBe('ok');
  });

  it('upgrades a stored v1 row into the provider-keyed shape', () => {
    // Codex was the only provider with launch-profile fields when v1 was
    // written, so every v1 row is a Codex specialization — which is what lets
    // the upgrade name the provider rather than asking for it.
    const result = agentProviderConfig.safeParse({
      version: '1',
      model: 'o3',
      effort: 'high',
      webSearch: 'false',
      instructions: 'be terse',
    });

    expect(result).toEqual({
      status: 'ok',
      data: {
        version: '2',
        providerId: 'codex',
        values: { model: 'o3', effort: 'high', webSearch: 'false', instructions: 'be terse' },
      },
    });
  });

  it('upgrades a v1 row that set nothing, rather than failing it', () => {
    expect(agentProviderConfig.safeParse({ version: '1' })).toEqual({
      status: 'ok',
      data: { version: '2', providerId: 'codex', values: {} },
    });
  });
});

describe('toSwitchSpecialization', () => {
  it('passes every stored setting through under the key the profile writer reads', () => {
    expect(
      toSwitchSpecialization({
        version: '2',
        providerId: 'codex',
        values: {
          model: 'o3',
          effort: 'high',
          verbosity: 'low',
          reasoningSummary: 'concise',
          webSearch: 'true',
          instructions: 'be terse',
        },
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

  it('carries a provider whose keys are its own, not Codex’s', () => {
    expect(
      toSwitchSpecialization({
        version: '2',
        providerId: 'opencode',
        values: { variant: 'high', temperature: '0.2', topP: '0.9' },
      })
    ).toEqual({ variant: 'high', temperature: '0.2', topP: '0.9' });
  });

  it('drops empty/whitespace fields so the base default stands', () => {
    expect(
      toSwitchSpecialization({
        version: '2',
        providerId: 'codex',
        values: { model: '  ', effort: '', instructions: 'x' },
      })
    ).toEqual({ instructions: 'x' });
  });

  it('returns undefined when nothing is set or the config is absent', () => {
    expect(toSwitchSpecialization(null)).toBeUndefined();
    expect(toSwitchSpecialization(undefined)).toBeUndefined();
    expect(
      toSwitchSpecialization({ version: '2', providerId: 'codex', values: {} })
    ).toBeUndefined();
    expect(
      toSwitchSpecialization({ version: '2', providerId: 'codex', values: { model: '   ' } })
    ).toBeUndefined();
  });
});

describe('form attributes ↔ stored config', () => {
  it('round-trips every setting', () => {
    const config = {
      version: '2' as const,
      providerId: 'codex',
      values: {
        model: 'o3',
        effort: 'none',
        verbosity: 'high',
        reasoningSummary: 'detailed',
        webSearch: 'false',
        instructions: 'be terse',
      },
    };

    expect(
      providerConfigFromAttributes(config.providerId, attributesFromProviderConfig(config))
    ).toEqual(config);
  });

  it('seeds a blank form from no config, and reads it back as nothing set', () => {
    const attributes = attributesFromProviderConfig(null);

    expect(attributes).toEqual({});
    expect(providerConfigFromAttributes('codex', attributes)).toBeNull();
  });

  it('stores a number field as a string rather than dropping it', () => {
    // The form hands numeric fields back as numbers (null when blank), so a
    // stored config that only took strings would silently lose them.
    expect(providerConfigFromAttributes('opencode', { temperature: 0.2, maxSteps: null })).toEqual({
      version: '2',
      providerId: 'opencode',
      values: { temperature: '0.2' },
    });
  });

  it('keeps web search off as a stored value — unset and off are different', () => {
    expect(providerConfigFromAttributes('codex', { webSearch: 'false' })).toEqual({
      version: '2',
      providerId: 'codex',
      values: { webSearch: 'false' },
    });
    expect(providerConfigFromAttributes('codex', { webSearch: '' })).toBeNull();
  });
});
