import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CODEX_SKILL_CONTENT } from './skill-file';

it('embeds the current Codex connector workflow', () => {
  const path = fileURLToPath(
    new URL('../../../../../../../connectors/codex-plugin/skills/switch/SKILL.md', import.meta.url)
  );
  expect(CODEX_SKILL_CONTENT).toBe(readFileSync(path, 'utf8'));
});
