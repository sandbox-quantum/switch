import { describe, expect, it } from 'vitest';
import { agentProviderConfig, toSwitchSpecialization } from './agent-provider-config';

describe('agentProviderConfig schema', () => {
  it('parses a versioned config and rejects an unversioned one', () => {
    const ok = agentProviderConfig.safeParse({ version: '1', model: 'gpt-5.6-terra' });
    expect(ok).toEqual({ status: 'ok', data: { version: '1', model: 'gpt-5.6-terra' } });

    expect(agentProviderConfig.safeParse({ model: 'x' }).status).not.toBe('ok');
  });
});

describe('toSwitchSpecialization', () => {
  it('maps effort → reasoningEffort and passes model/instructions through', () => {
    expect(
      toSwitchSpecialization({
        version: '1',
        model: 'o3',
        effort: 'high',
        instructions: 'be terse',
      })
    ).toEqual({ model: 'o3', reasoningEffort: 'high', instructions: 'be terse' });
  });

  it('drops empty/whitespace fields so the base default stands', () => {
    expect(
      toSwitchSpecialization({ version: '1', model: '  ', effort: '', instructions: 'x' })
    ).toEqual({ model: undefined, reasoningEffort: undefined, instructions: 'x' });
  });

  it('returns undefined when nothing is set or the config is absent', () => {
    expect(toSwitchSpecialization(null)).toBeUndefined();
    expect(toSwitchSpecialization(undefined)).toBeUndefined();
    expect(toSwitchSpecialization({ version: '1' })).toBeUndefined();
    expect(toSwitchSpecialization({ version: '1', model: '   ' })).toBeUndefined();
  });
});
