import { describe, expect, it } from 'vitest';
import '@main/core/providers/plugin-registry';
import { knownAgentTypeForProvider } from './known-agent-type';

describe('knownAgentTypeForProvider', () => {
  it('maps claude to claude-code', () => {
    expect(knownAgentTypeForProvider('claude')).toBe('claude-code');
  });

  it.each(['codex', 'opencode', 'antigravity', 'cursor'])(
    'registers %s under its own gateway known-agent type',
    (providerId) => {
      // Without this OpenCode fell through to a fallback and registered as
      // claude-code, so an operator onboarding it by hand was told to run
      // `claude` in an OpenCode agent's directory.
      expect(knownAgentTypeForProvider(providerId)).toBe(providerId);
    }
  );

  it('refuses a provider this build does not have', () => {
    expect(() => knownAgentTypeForProvider('nope')).toThrow("unknown agent provider 'nope'");
  });
});
