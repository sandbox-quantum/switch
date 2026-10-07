import { expect, it } from 'vitest';
import { hostedSkillsDirectory, hostedSkillsSchema, supportsHostedSkills } from './hosted-skills';

it('rejects unsafe, oversized or unsupported connection skills', () => {
  const skill = (files: Record<string, string>, slug = 'github') => ({ slug, files });
  const valid = skill({ 'SKILL.md': 'x' });
  expect(hostedSkillsSchema.safeParse([valid]).success).toBe(true);
  for (const skills of [
    [],
    [skill({ 'README.md': 'x' })],
    [skill({ 'SKILL.md': 'x', '../escape.md': 'x' })],
    [skill({ 'SKILL.md': 'x', '/abs.md': 'x' })],
    [skill({ 'SKILL.md': 'x', 'a/../b.md': 'x' })],
    [skill({ 'SKILL.md': 'x\0' })],
    [skill({ 'SKILL.md': 'x'.repeat(32 * 1024 + 1) })],
    [skill({ 'SKILL.md': 'x' }, '../github')],
    [valid, valid],
    [{ ...valid, extra: true }],
  ])
    expect(hostedSkillsSchema.safeParse(skills).success).toBe(false);
  for (const kind of ['cursor', 'antigravity'] as const)
    expect(supportsHostedSkills(kind)).toBe(false);
});

it('maps each skills-capable provider to the directory its agent reads', () => {
  const env = { HOME: '/r/home', CLAUDE_CONFIG_DIR: '/r/claude', XDG_CONFIG_HOME: '/r/xdg' };
  expect(hostedSkillsDirectory('claude', env)).toBe('/r/claude/skills');
  expect(hostedSkillsDirectory('codex', { ...env, CODEX_HOME: '/r/codex' })).toBe(
    '/r/codex/skills'
  );
  expect(hostedSkillsDirectory('codex', env)).toBe('/r/home/.codex/skills');
  expect(hostedSkillsDirectory('opencode', env)).toBe('/r/xdg/opencode/skills');
  expect(() => hostedSkillsDirectory('opencode', { HOME: '/r/home' })).toThrow(/not configured/);
});
