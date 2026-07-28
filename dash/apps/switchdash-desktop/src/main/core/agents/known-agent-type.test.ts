import { describe, expect, it } from 'vitest';
import { knownAgentTypeForProvider } from './known-agent-type';

describe('knownAgentTypeForProvider', () => {
  it('maps codex to its own gateway known-agent type', () => {
    expect(knownAgentTypeForProvider('codex')).toBe('codex');
  });

  it('maps every other provider to claude-code (the generic managed shape)', () => {
    for (const id of ['claude', 'grok', 'gemini', 'cursor', 'droid'] as const) {
      expect(knownAgentTypeForProvider(id)).toBe('claude-code');
    }
  });
});
