import { mkdtemp, readFile, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { prepareGeminiHome } from './home';

it('isolates settings, preserves refreshed login, and preserves host MCP configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gemini-home-test-'));
  try {
    const sourceHome = join(root, 'source');
    await mkdir(sourceHome);
    await writeFile(
      join(sourceHome, 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'oauth-personal' } },
        mcpServers: { unrelated: { command: 'unrelated' } },
      })
    );
    await writeFile(join(sourceHome, 'oauth_creds.json'), 'fixture-not-a-credential');
    const input = {
      root: join(root, 'sessions'),
      sourceHome,
      sessionId: '../unsafe',
      context: 'Switch instructions',
      mcpServerNames: ['switch'],
    };
    const home = await prepareGeminiHome(input);
    const configDir = join(home, '.gemini');
    const config = JSON.parse(await readFile(join(configDir, 'settings.json'), 'utf8'));
    expect(config.mcpServers).toEqual({ unrelated: { command: 'unrelated' } });
    expect(config.security.auth.selectedType).toBe('oauth-personal');
    expect(config.tools.exclude).toContain('ask_user');
    expect(await readFile(join(configDir, 'GEMINI.md'), 'utf8')).toBe('Switch instructions');
    expect(config.mcp.allowed).toEqual(['unrelated', 'switch']);
    expect((await stat(configDir)).mode & 0o777).toBe(0o700);
    await writeFile(join(configDir, 'oauth_creds.json'), 'refreshed-fixture');
    expect(await prepareGeminiHome(input)).toBe(home);
    expect(await readFile(join(configDir, 'oauth_creds.json'), 'utf8')).toBe('refreshed-fixture');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
