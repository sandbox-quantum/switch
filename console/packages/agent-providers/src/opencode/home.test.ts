import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildConfigFile } from './config';
import { prepareOpencodeHome } from './home';

it('preserves native JSONC configuration, skills, MCP, paths and credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-home-test-'));
  const source = join(root, '.config/opencode');
  let prepared: string | null = null;
  try {
    await mkdir(join(source, 'skills/user-skill'), { recursive: true });
    await writeFile(join(source, 'skills/user-skill/SKILL.md'), 'User-owned skill');
    const original =
      '{ // Native settings\n "model": "example/model", "mcp": { "user": { "type": "local", "command": ["node", "server.js"] } }, "permission": { "bash": "deny" }, "instructions": ["instructions.md"], "plugin": ["./plugin.js"], }';
    await writeFile(join(source, 'opencode.jsonc'), original);
    await writeFile(join(root, 'auth-sentinel'), 'unchanged');
    prepared = await prepareOpencodeHome(
      buildConfigFile('approval-required', {
        switch: { transport: 'stdio', command: 'node', args: ['managed.mjs'] },
      }),
      [{ name: 'managed', content: 'Managed skill' }],
      { HOME: root }
    );
    const result = JSON.parse(await readFile(join(prepared, 'opencode/opencode.json'), 'utf8'));
    expect(result.model).toBe('example/model');
    expect(Object.keys(result.mcp).sort()).toEqual(['switch', 'user']);
    expect(result.permission.bash).toBe('deny');
    expect(result.instructions).toEqual([join(source, 'instructions.md')]);
    expect(result.plugin).toEqual([join(source, 'plugin.js')]);
    expect(await realpath(join(prepared, 'opencode/skills'))).toBe(
      await realpath(join(source, 'skills'))
    );
    expect(await readFile(join(source, 'opencode.jsonc'), 'utf8')).toBe(original);
    expect(await readFile(join(root, 'auth-sentinel'), 'utf8')).toBe('unchanged');
    expect(await readFile(join(result.skills.paths[0], 'managed/SKILL.md'), 'utf8')).toBe(
      'Managed skill'
    );
  } finally {
    if (prepared) await rm(prepared, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});
