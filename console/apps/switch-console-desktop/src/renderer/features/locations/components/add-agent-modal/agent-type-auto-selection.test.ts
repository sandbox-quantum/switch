import { describe, expect, it } from 'vitest';
import type { AgentProviderId } from '@shared/core/providers/agent-provider-registry';
import { autoSelectedAgentType } from './agent-type-auto-selection';

const CLAUDE = 'claude' as AgentProviderId;
const CODEX = 'codex' as AgentProviderId;
const OPENCODE = 'opencode' as AgentProviderId;

describe('autoSelectedAgentType', () => {
  it('picks nothing when no type is usable', () => {
    expect(autoSelectedAgentType([], 'claude')).toBeNull();
  });

  it('picks the only usable type, default or not', () => {
    expect(autoSelectedAgentType([CODEX], 'claude')).toBe(CODEX);
    expect(autoSelectedAgentType([CODEX], undefined)).toBe(CODEX);
  });

  it('picks the default when several are usable', () => {
    expect(autoSelectedAgentType([CLAUDE, CODEX], 'codex')).toBe(CODEX);
    expect(autoSelectedAgentType([CLAUDE, CODEX], 'claude')).toBe(CLAUDE);
  });

  it('leaves the choice to the user when the default is not usable here', () => {
    expect(autoSelectedAgentType([CLAUDE, CODEX], 'opencode')).toBeNull();
  });

  it('leaves the choice to the user while the default is still loading', () => {
    expect(autoSelectedAgentType([CLAUDE, CODEX], undefined)).toBeNull();
  });

  // The bug this rule replaced keyed on `length === 1`, so onboarding silently
  // changed behaviour the moment a second connector shipped. A third must not
  // move it again.
  it('does not depend on how many types are usable', () => {
    expect(autoSelectedAgentType([CLAUDE, CODEX, OPENCODE], 'codex')).toBe(CODEX);
    expect(autoSelectedAgentType([CLAUDE, CODEX, OPENCODE], undefined)).toBeNull();
  });

  it('does not depend on the order they arrive in', () => {
    expect(autoSelectedAgentType([OPENCODE, CODEX, CLAUDE], 'claude')).toBe(CLAUDE);
    expect(autoSelectedAgentType([CLAUDE, CODEX, OPENCODE], 'claude')).toBe(CLAUDE);
  });
});
