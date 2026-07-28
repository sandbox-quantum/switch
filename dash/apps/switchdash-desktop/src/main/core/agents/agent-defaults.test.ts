import { describe, expect, it } from 'vitest';
import { slugifyAgentNamePart, suggestAgentDefaults } from './agent-defaults';

describe('slugifyAgentNamePart', () => {
  it('lowercases and keeps the allowed charset', () => {
    expect(slugifyAgentNamePart('My-Repo.v2_x')).toBe('my-repo.v2_x');
  });

  it('replaces disallowed characters with a single hyphen', () => {
    expect(slugifyAgentNamePart('foo bar//baz')).toBe('foo-bar-baz');
  });

  it('strips leading and trailing hyphens', () => {
    expect(slugifyAgentNamePart('  @weird@  ')).toBe('weird');
  });

  it('returns empty for an all-disallowed string', () => {
    expect(slugifyAgentNamePart('@@@')).toBe('');
  });
});

describe('suggestAgentDefaults', () => {
  it('builds a claude-code.<repo>.<user> name and matches the agent-name pattern', () => {
    const { name, description } = suggestAgentDefaults('/Users/someone/My Repo', 'claude');
    expect(name.startsWith('claude-code.my-repo')).toBe(true);
    expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(description).toBe('Claude Code running in My Repo');
  });

  it('prefixes the name and description with the chosen provider (Codex)', () => {
    const { name, description } = suggestAgentDefaults('/Users/someone/My Repo', 'codex');
    expect(name.startsWith('codex.my-repo')).toBe(true);
    expect(name).not.toContain('claude-code');
    expect(name).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    expect(description).toBe('Codex running in My Repo');
  });
});
