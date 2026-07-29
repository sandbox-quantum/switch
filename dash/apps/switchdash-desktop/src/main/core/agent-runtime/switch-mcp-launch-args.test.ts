import { codexMcpAdapter } from '@switchdash/core/agents/plugins/helpers';
import { describe, expect, it } from 'vitest';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { switchMcpLaunchArgs } from './switch-mcp-launch-args';

type Plugin = ReturnType<typeof getPlugin>;

/** The real Codex MCP behavior — it renders servers onto argv. */
const codexPlugin = { behavior: { mcp: codexMcpAdapter() } } as unknown as Plugin;

/** A provider whose connector resolves MCP servers itself, as Claude's does. */
const claudeLikePlugin = { behavior: { mcp: {} } } as unknown as Plugin;

describe('switchMcpLaunchArgs', () => {
  it('registers the Switch server by endpoint, naming the token env var rather than embedding it', () => {
    const args = switchMcpLaunchArgs(codexPlugin, 'https://switch.test/api');
    expect(args).toEqual([
      '-c',
      'mcp_servers.switch.url="https://switch.test/api/mcp/"',
      '-c',
      'mcp_servers.switch.bearer_token_env_var="SWITCH_API_TOKEN"',
    ]);
  });

  it('never puts the token itself on argv', () => {
    // argv is world-readable via `ps`; only the variable's *name* may appear.
    const args = switchMcpLaunchArgs(codexPlugin, 'https://switch.test/api').join(' ');
    expect(args).toContain('bearer_token_env_var');
    expect(args).not.toMatch(/Bearer\s/);
  });

  it('emits url and token together, because -c replaces a server table wholesale', () => {
    // Overriding one key of mcp_servers.<name> discards the rest, so a partial
    // set would leave the server unauthenticated rather than merged.
    const keys = switchMcpLaunchArgs(codexPlugin, 'https://switch.test/api')
      .filter((a) => a !== '-c')
      .map((a) => a.split('=')[0]);
    expect(keys).toEqual(['mcp_servers.switch.url', 'mcp_servers.switch.bearer_token_env_var']);
  });

  it('normalises trailing slashes on the endpoint', () => {
    expect(switchMcpLaunchArgs(codexPlugin, 'https://switch.test/api///')).toContain(
      'mcp_servers.switch.url="https://switch.test/api/mcp/"'
    );
  });

  it('emits nothing when the provider resolves MCP servers some other way', () => {
    expect(switchMcpLaunchArgs(claudeLikePlugin, 'https://switch.test/api')).toEqual([]);
  });

  it('emits nothing when the session has no Switch identity', () => {
    // No credentials means no endpoint; a half-formed server is worse than none.
    for (const endpoint of [undefined, '', '   ']) {
      expect(switchMcpLaunchArgs(codexPlugin, endpoint)).toEqual([]);
    }
  });
});
