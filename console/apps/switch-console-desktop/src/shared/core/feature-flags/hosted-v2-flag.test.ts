import { describe, expect, it } from 'vitest';
import { allFeatureFlagsOff, resolveFeatureFlags } from './feature-flags';

// The v1/v2 switch: Console reads Core's one answer, `hosted_v2`, and never works it out itself.
describe('the hosted_v2 flag', () => {
  it('is on only when Core sends it on', () => {
    expect(resolveFeatureFlags([{ key: 'hosted_v2', enabled: true }]).hosted_v2).toBe(true);
    expect(resolveFeatureFlags([{ key: 'hosted_v2', enabled: false }]).hosted_v2).toBe(false);
  });

  it('is off when an older Core does not send it, even with hosted_agents on (fails closed)', () => {
    const flags = resolveFeatureFlags([{ key: 'hosted_agents', enabled: true }]);
    expect(flags.hosted_agents).toBe(true);
    expect(flags.hosted_v2).toBe(false);
    expect(allFeatureFlagsOff().hosted_v2).toBe(false);
  });
});
