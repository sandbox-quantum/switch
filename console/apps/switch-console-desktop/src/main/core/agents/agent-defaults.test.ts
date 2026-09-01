import { describe, expect, it } from 'vitest';
import { AGENT_NAME_PATTERN } from '@shared/core/agents/agent-slug';
import { suggestAgentDefaults } from './agent-defaults';

describe('suggestAgentDefaults', () => {
  it('builds a claude-code.<repo>.<user> name and matches the agent-name pattern', () => {
    const { name, description } = suggestAgentDefaults('/Users/someone/My Repo', 'claude');
    expect(name.startsWith('claude-code.my-repo')).toBe(true);
    expect(name).toMatch(AGENT_NAME_PATTERN);
    expect(description).toBe('Claude Code running in My Repo');
  });

  it('prefixes the name and description with the chosen provider (Codex)', () => {
    const { name, description } = suggestAgentDefaults('/Users/someone/My Repo', 'codex');
    expect(name.startsWith('codex.my-repo')).toBe(true);
    expect(name).not.toContain('claude-code');
    expect(name).toMatch(AGENT_NAME_PATTERN);
    expect(description).toBe('Codex running in My Repo');
  });

  it('slugifies a dotfile-style directory into a valid name part', () => {
    const { name } = suggestAgentDefaults('/Users/someone/.Hidden Repo', 'codex');
    expect(name.startsWith('codex.hidden-repo')).toBe(true);
    expect(name).toMatch(AGENT_NAME_PATTERN);
  });
});
