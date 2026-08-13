import { beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from '@main/lib/logger';
import { knownAgentTypeForProvider } from './known-agent-type';

vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('knownAgentTypeForProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps codex to its own gateway known-agent type', () => {
    expect(knownAgentTypeForProvider('codex')).toBe('codex');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('maps claude to claude-code', () => {
    expect(knownAgentTypeForProvider('claude')).toBe('claude-code');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('maps opencode to its own gateway known-agent type', () => {
    // Without this it fell through to the fallback and registered as
    // claude-code, so an operator onboarding it by hand was told to run
    // `claude` in an OpenCode agent's directory.
    expect(knownAgentTypeForProvider('opencode')).toBe('opencode');
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('warns when a provider has no gateway known-agent type, then falls back visibly', () => {
    // Only the types in KNOWN_AGENTS exist server-side, so anything else
    // registers as a type it is not. That is a disclosed fallback, never a
    // silent one.
    for (const id of ['grok', 'gemini', 'cursor', 'droid'] as const) {
      vi.clearAllMocks();
      expect(knownAgentTypeForProvider(id)).toBe('claude-code');
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('no gateway known-agent type'),
        expect.objectContaining({ providerId: id, registeringAs: 'claude-code' })
      );
    }
  });
});
