import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CLAUDE_SKILL_CONTENT } from './skill-file';

it('embeds the current Claude connector workflow', () => {
  const path = fileURLToPath(
    new URL(
      '../../../../../../../connectors/claude-code-plugin/skills/switch/SKILL.md',
      import.meta.url
    )
  );
  expect(CLAUDE_SKILL_CONTENT).toBe(readFileSync(path, 'utf8'));
});
