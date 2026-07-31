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

import { buildStandardCommand } from '@switchdash/core/agents/plugins/helpers';
import { SWITCH_API_ENDPOINT_PLACEHOLDER } from '@shared/core/switch-rooms/switch-mcp-endpoint';
import {
  INITIAL_PROMPT_PLACEHOLDER,
  materializeAgentCommand,
  SESSION_ID_PLACEHOLDER,
} from '../../../sidecar/agent-launch-spec';
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

/**
 * The suite above mocks `buildCommand`, so it cannot see provider-specific argv
 * constraints. Codex sets `sessionIdOnResumeOnly`: its fresh-session argv carries
 * no session-id token at all, and a watcher that requires one rejects every spec
 * it produces. These drive the real provider spec instead.
 */
describe('generateAgentLaunchSpec against real provider command builders', () => {
  const CODEX_SPEC = {
    defaultArgs: ['--dangerously-bypass-hook-trust'],
    autoApproveFlag: '-c approval_policy="never" -c sandbox_mode="danger-full-access"',
    initialPromptFlag: '',
    resumeFlag: 'resume',
    sessionIdFlag: ' ',
    sessionIdOnResumeOnly: true,
    resumeWithoutSessionFlag: 'resume --last',
  };

  /** What `generateAgentLaunchSpec` asks a provider to build. */
  function buildSpecArgs(providerSpec: Parameters<typeof buildStandardCommand>[1]): string[] {
    return buildStandardCommand(
      {
        cli: '/usr/bin/agent',
        extraArgs: [],
        agentArgs: ['-c', `mcp_servers.switch.url="${SWITCH_API_ENDPOINT_PLACEHOLDER}/mcp/"`],
        autoApprove: true,
        initialPrompt: INITIAL_PROMPT_PLACEHOLDER,
        sessionId: SESSION_ID_PLACEHOLDER,
        providerSessionId: undefined,
        isResuming: false,
        model: '',
      },
      providerSpec
    ).args;
  }

  it('produces a Codex spec the watcher can materialize', () => {
    const args = buildSpecArgs(CODEX_SPEC);
    expect(args).not.toContain(SESSION_ID_PLACEHOLDER);

    const cmd = materializeAgentCommand(
      {
        command: '/usr/bin/codex',
        args,
        env: {},
        cwd: '/home/agent/repo',
        providerId: 'codex',
        deeplinkScheme: 'switchdash',
      },
      {
        sessionId: 's1',
        initialPrompt: 'connect to switch room room-x',
        extraEnv: {},
        switchApiEndpoint: 'https://switch.test/api',
      }
    );

    expect(cmd.args).toContain('mcp_servers.switch.url="https://switch.test/api/mcp/"');
    expect(cmd.args).toContain('connect to switch room room-x');
  });

  it('still carries the session id for a provider that takes one when fresh', () => {
    const args = buildSpecArgs({ initialPromptFlag: '', sessionIdFlag: '--session-id' });
    expect(args).toContain(SESSION_ID_PLACEHOLDER);

    const cmd = materializeAgentCommand(
      {
        command: '/usr/bin/claude',
        args,
        env: {},
        cwd: '/home/agent/repo',
        providerId: 'claude',
        deeplinkScheme: 'switchdash',
      },
      {
        sessionId: 's1',
        initialPrompt: 'p',
        extraEnv: {},
        switchApiEndpoint: 'https://switch.test/api',
      }
    );

    expect(cmd.args).toContain('s1');
  });
});
