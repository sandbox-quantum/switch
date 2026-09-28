import { describe, expect, it } from 'vitest';
import { SWITCH_SKILL_CONTEXT, SWITCH_SKILL_FILE, SWITCH_SKILL_NAME } from './index';

describe('switch skill', () => {
  it('declares the name its skills folder is given', () => {
    const name = /^---\n(?:.*\n)*?name:\s*"?([\w-]+)"?\s*$/m.exec(SWITCH_SKILL_FILE)?.[1];
    expect(name).toBe(SWITCH_SKILL_NAME);
  });

  it('gives context hosts the body without the frontmatter', () => {
    expect(SWITCH_SKILL_CONTEXT.startsWith('# Switch Room Workflow\n')).toBe(true);
    expect(SWITCH_SKILL_FILE.endsWith(SWITCH_SKILL_CONTEXT)).toBe(true);
  });
});
