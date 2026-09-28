import skill from './SKILL.md';

/**
 * The Switch room-workflow skill every session is given, as a skill file:
 * frontmatter and body. Codex and OpenCode load it from a skills directory
 * under the name `switch`, which must match the frontmatter's `name`.
 */
export const SWITCH_SKILL_FILE: string = skill;

/** The folder name a skills directory needs for {@link SWITCH_SKILL_FILE}. */
export const SWITCH_SKILL_NAME = 'switch';

/**
 * The same skill without its frontmatter, for hosts that take it as system
 * context rather than as a loadable skill (Claude Code, Cursor, Antigravity).
 */
export const SWITCH_SKILL_CONTEXT: string = skill.replace(/^---\n[\s\S]*?\n---\n+/, '');
