import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildCommand = vi.fn(() => ({ command: 'claude', args: ['--x'], env: { E: '1' } }));
const launchArgs = vi.fn((dir: string, name: string) => [
  '--agent',
  name,
  '--settings',
  `${dir}/.switch/agents/${name}.json`,
]);

const launchArgsForServer = vi.fn((server: { name: string; url?: string }) => [
  '-c',
  `mcp_servers.${server.name}.url=${JSON.stringify(server.url)}`,
]);
/** Set per test: whether the mocked provider receives MCP servers on argv. */
let mcpBehavior: { launchArgsForServer?: typeof launchArgsForServer } | undefined;

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({
    behavior: { prompt: { buildCommand }, repoAgents: { launchArgs }, mcp: mcpBehavior },
    capabilities: { hostDependency: { binaryNames: ['claude'] } },
  }),
}));
vi.mock('@main/core/agent-runtime/impl/resolve-agent-executable', () => ({
  resolveAgentExecutable: vi.fn(async () => '/usr/bin/claude'),
}));
vi.mock('@main/core/settings/provider-settings-service', () => ({
  providerOverrideSettings: { getItem: vi.fn(async () => undefined) },
}));
vi.mock('@main/core/dependencies/host-dependency-store', () => ({ hostDependencyStore: {} }));

import { SWITCH_API_ENDPOINT_PLACEHOLDER } from '@shared/core/switch-rooms/switch-mcp-endpoint';
import { generateAgentLaunchSpec } from './generate-agent-launch-spec';

const baseParams = {
  providerId: 'claude',
  remoteRepoDir: '/home/agent/repo',
  deeplinkScheme: 'switchdash',
  agentName: null,
  ctx: {} as never,
  connectionId: 'conn-1',
};

describe('generateAgentLaunchSpec', () => {
  beforeEach(() => {
    buildCommand.mockClear();
    launchArgs.mockClear();
    launchArgsForServer.mockClear();
    mcpBehavior = undefined;
  });

  // The bug (CHOO-1664): autoApprove was hardcoded true, so the remote watcher's
  // auto-started sessions always bypassed permissions regardless of the setting.
  it('forwards autoApprove: true to the provider buildCommand', async () => {
    await generateAgentLaunchSpec({ ...baseParams, autoApprove: true });
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: true }));
  });

  it('forwards autoApprove: false (no longer hardcoded on)', async () => {
    await generateAgentLaunchSpec({ ...baseParams, autoApprove: false });
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ autoApprove: false }));
  });

  it('appends the definition launch args so auto-started sessions run as the definition', async () => {
    await generateAgentLaunchSpec({ ...baseParams, autoApprove: false, agentName: 'reviewer' });
    expect(launchArgs).toHaveBeenCalledWith('/home/agent/repo', 'reviewer');
    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentArgs: [
          '--agent',
          'reviewer',
          '--settings',
          '/home/agent/repo/.switch/agents/reviewer.json',
        ],
      })
    );
  });

  it('adds no definition launch args when the agent has no definition', async () => {
    await generateAgentLaunchSpec({ ...baseParams, autoApprove: false, agentName: null });
    expect(launchArgs).not.toHaveBeenCalled();
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ agentArgs: [] }));
  });

  it('bakes an endpoint placeholder for a provider that takes MCP servers on argv', async () => {
    // The endpoint is only known on the VM, so the spec carries a token the
    // watcher substitutes per spawn. Without it a remote auto-started Codex
    // session gets its token from the sidecar but no `switch` tools at all.
    mcpBehavior = { launchArgsForServer };

    await generateAgentLaunchSpec({ ...baseParams, autoApprove: false });

    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        agentArgs: ['-c', `mcp_servers.switch.url="${SWITCH_API_ENDPOINT_PLACEHOLDER}/mcp/"`],
      })
    );
  });

  it('adds no MCP args for a provider that resolves servers from config', async () => {
    await generateAgentLaunchSpec({ ...baseParams, autoApprove: false });

    expect(launchArgsForServer).not.toHaveBeenCalled();
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ agentArgs: [] }));
  });
});
