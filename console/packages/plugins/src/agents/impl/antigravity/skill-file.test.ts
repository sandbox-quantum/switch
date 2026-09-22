import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { ANTIGRAVITY_SKILL_CONTENT } from './skill-file';

it('embeds the current Antigravity CLI workflow', () => {
  const path = fileURLToPath(
    new URL(
      '../../../../../../../connectors/antigravity-cli/skills/switch/SKILL.md',
      import.meta.url
    )
  );
  expect(ANTIGRAVITY_SKILL_CONTENT).toBe(readFileSync(path, 'utf8'));
});
