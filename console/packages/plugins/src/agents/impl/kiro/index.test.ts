import type { PluginFs } from '@switch-console/core/agents/plugins';
import { describe, expect, it } from 'vitest';
import { plugin, provider } from './index';
function createMemoryFs(initial: Record<string, string> = {}): PluginFs {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    async read(path) {
      return store.get(path) ?? null;
    },
    async write(path, content) {
      store.set(path, content);
    },
    async delete(path) {
      store.delete(path);
    },
    async exists(path) {
      return store.has(path);
    },
    async list() {
      return [];
    },
  };
}
describe('Kiro MCP capability', () => {
  it('declares global MCP support for stdio and HTTP', () => {
    expect(plugin.capabilities.mcp).toEqual({
      kind: 'supported',
      scope: 'global',
      supportedTransports: ['stdio', 'http'],
    });
  });
  it('reads MCP servers from the Kiro global config path', async () => {
    const fs = createMemoryFs({
      '.kiro/settings/mcp.json': JSON.stringify({
        mcpServers: {
          docs: {
            command: 'npx',
            args: ['-y', 'docs-server'],
          },
        },
      }),
    });

    const servers = await provider.behavior.mcp!.readServers(fs);

    expect(servers).toEqual([
      {
        name: 'docs',
        command: 'npx',
        args: ['-y', 'docs-server'],
      },
    ]);
  });

  it('registers the MCP configuration behavior', () => {
    expect(provider.behavior.mcp).toBeDefined();
    expect(typeof provider.behavior.mcp?.readServers).toBe('function');
    expect(typeof provider.behavior.mcp?.writeServers).toBe('function');
    expect(typeof provider.behavior.mcp?.removeServer).toBe('function');
  });
  it('removes only the requested MCP server', async () => {
    const fs = createMemoryFs({
      '.kiro/settings/mcp.json': JSON.stringify({
        mcpServers: {
          docs: { command: 'npx', args: ['docs-server'] },
          github: { command: 'npx', args: ['github-server'] },
        },
      }),
    });

    await provider.behavior.mcp!.removeServer(fs, 'docs');

    const servers = await provider.behavior.mcp!.readServers(fs);

    expect(servers.map((server) => server.name)).toEqual(['github']);
  });
  it('writes MCP servers while preserving existing Kiro settings', async () => {
    const fs = createMemoryFs({
      '.kiro/settings/mcp.json': JSON.stringify({
        otherSetting: true,
        mcpServers: {},
      }),
    });

    await provider.behavior.mcp!.writeServers(fs, [
      {
        name: 'docs',
        command: 'npx',
        args: ['-y', 'docs-server'],
      },
    ]);

    const content = await fs.read('.kiro/settings/mcp.json');
    const parsed = JSON.parse(content!);

    expect(parsed.otherSetting).toBe(true);
    expect(parsed.mcpServers.docs).toEqual({
      command: 'npx',
      args: ['-y', 'docs-server'],
    });
  });
});
