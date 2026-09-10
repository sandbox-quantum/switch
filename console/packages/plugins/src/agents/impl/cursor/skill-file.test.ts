import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { CURSOR_SKILL_CONTENT } from './skill-file';

it('embeds the current Cursor CLI workflow', () => {
  const path = fileURLToPath(
    new URL('../../../../../../../connectors/cursor-cli/skills/switch/SKILL.md', import.meta.url)
  );
  expect(CURSOR_SKILL_CONTENT).toBe(readFileSync(path, 'utf8'));
});
