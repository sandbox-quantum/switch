import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { GEMINI_SKILL_CONTENT } from './skill-file';

it('embeds the current Gemini CLI workflow', () => {
  const path = fileURLToPath(
    new URL('../../../../../../../connectors/gemini-cli/skills/switch/SKILL.md', import.meta.url)
  );
  expect(GEMINI_SKILL_CONTENT).toBe(readFileSync(path, 'utf8'));
});
