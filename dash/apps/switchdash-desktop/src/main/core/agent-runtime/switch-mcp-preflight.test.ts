import type { PluginFs } from '@switchdash/core/agents/plugins';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { assertSwitchMcpNameFree } from './switch-mcp-preflight';

const h = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: h.warn, error: vi.fn() } }));

type Plugin = ReturnType<typeof getPlugin>;

/** A plugin whose MCP behavior reports `servers` and takes them on argv. */
function argvPlugin(servers: Array<{ name: string }>): Plugin {
  return {
    behavior: {
      mcp: {
        readServers: vi.fn(async () => servers),
        launchArgsForServer: () => ['-c', 'x'],
      },
    },
  } as unknown as Plugin;
}

/** A provider that resolves MCP servers from its own config (Claude Code). */
function configPlugin(servers: Array<{ name: string }>): Plugin {
  return {
    behavior: { mcp: { readServers: vi.fn(async () => servers) } },
  } as unknown as Plugin;
}

const anyFs = {} as PluginFs;

describe('assertSwitchMcpNameFree', () => {
  beforeEach(() => h.warn.mockClear());

  it('throws when the config already defines a server called switch', async () => {
    // `-c mcp_servers.switch.url=…` merges into that table, producing an entry
    // with both `command` and `url` that Codex refuses to load at all.
    await expect(
      assertSwitchMcpNameFree(argvPlugin([{ name: 'switch' }]), 'codex', anyFs)
    ).rejects.toThrow(/already defines an MCP server named "switch"/);
  });

  it('resolves when the config defines other servers', async () => {
    await expect(
      assertSwitchMcpNameFree(argvPlugin([{ name: 'github' }]), 'codex', anyFs)
    ).resolves.toBeUndefined();
  });

  it('ignores a switch server for a provider that reads MCP from config', async () => {
    // For Claude Code a `switch` entry is the wanted state, not a collision.
    await expect(
      assertSwitchMcpNameFree(configPlugin([{ name: 'switch' }]), 'claude', anyFs)
    ).resolves.toBeUndefined();
  });

  it('warns instead of passing silently when the home scope is unreadable', async () => {
    // A remote agent's VM home is not mounted, so "no servers found" would be an
    // answer about switchdash's own filesystem, not the agent's.
    const plugin = argvPlugin([{ name: 'switch' }]);

    await expect(assertSwitchMcpNameFree(plugin, 'codex', null)).resolves.toBeUndefined();

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping the MCP name collision check'),
      expect.objectContaining({ providerId: 'codex' })
    );
    expect(plugin.behavior.mcp?.readServers).not.toHaveBeenCalled();
  });
});
