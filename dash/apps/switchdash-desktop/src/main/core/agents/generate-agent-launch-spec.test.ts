import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildCommand = vi.fn(() => ({ command: 'claude', args: ['--x'], env: { E: '1' } }));

vi.mock('@main/core/providers/plugin-registry', () => ({
  getPlugin: () => ({
    behavior: { prompt: { buildCommand } },
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

import { generateAgentLaunchSpec } from './generate-agent-launch-spec';

const baseParams = {
  providerId: 'claude',
  remoteRepoDir: '/home/agent/repo',
  deeplinkScheme: 'switchdash',
  ctx: {} as never,
  connectionId: 'conn-1',
};

describe('generateAgentLaunchSpec', () => {
  beforeEach(() => buildCommand.mockClear());

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
});
