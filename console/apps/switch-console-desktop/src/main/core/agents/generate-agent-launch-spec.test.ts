import { pluginRegistry } from '@switch-console/plugins/agents';
import { parse as parseTOML } from 'smol-toml';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildCommand = vi.fn(() => ({ command: 'claude', args: ['--x'], env: { E: '1' } }));
const launchArgs = vi.fn((dir: string, name: string) => [
  '--agent',
  name,
  '--settings',
  `${dir}/.switch/agents/${name}.json`,
]);

const launchProfile = vi.fn(
  (params: { slug: string; values: Record<string, string | undefined> }) =>
    params.values.model || params.values.instructions
      ? {
          files: [{ relativePath: `.codex/${params.slug}.config.toml`, content: 'PROFILE' }],
          args: ['--profile', params.slug],
          env: { PROFILE_PATH: `__SWITCHDASH_HOME__/.codex/${params.slug}.config.toml` },
        }
      : null
);
/** Set per test: whether the mocked provider takes specialization from a file. */
let mcpBehavior: { launchProfile?: typeof launchProfile } | undefined;

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

import { buildStandardCommand } from '@switch-console/core/agents/plugins/helpers';
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
  credsSlug: 'hoot',
  ctx: {} as never,
  connectionId: 'conn-1',
};

describe('generateAgentLaunchSpec', () => {
  beforeEach(() => {
    buildCommand.mockClear();
    launchArgs.mockClear();
    launchProfile.mockClear();
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

  it('bakes the profile args and launch file for a provider that specializes from a file', async () => {
    // The endpoint and credentials reach the runtime through the env, and the
    // Switch server through the connector plugin, so the spec carries only the
    // per-agent profile the sidecar writes on the VM plus `--profile <slug>`.
    mcpBehavior = { launchProfile };

    const spec = await generateAgentLaunchSpec({
      ...baseParams,
      autoApprove: false,
      specialization: { model: 'gpt-5.6-terra' },
    });

    expect(launchProfile).toHaveBeenCalledWith(expect.objectContaining({ slug: 'hoot' }));
    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agentArgs: ['--profile', 'hoot'] })
    );
    expect(spec.launchFiles).toEqual([
      { homeRelativePath: '.codex/hoot.config.toml', content: 'PROFILE' },
    ]);
  });

  it("bakes a profile's env with the home placeholder left for the sidecar", async () => {
    // A provider that names its config through the environment (OpenCode) needs
    // an absolute path, and this runs on the desktop, which does not know the
    // VM's home. The placeholder survives into the spec deliberately; the
    // sidecar substitutes it where it writes the file.
    mcpBehavior = { launchProfile };

    const spec = await generateAgentLaunchSpec({
      ...baseParams,
      autoApprove: false,
      specialization: { model: 'gpt-5.6-terra' },
    });

    expect(spec.env.PROFILE_PATH).toBe('__SWITCHDASH_HOME__/.codex/hoot.config.toml');
  });

  it('bakes a profile that carries no credential and registers no server', async () => {
    // The sidecar writes this file verbatim on the VM, so whatever is baked here
    // is what a remote session runs with — and a value baked in would be a secret
    // shipped to the box and re-read on every poll. The Switch server is not
    // baked either: the connector plugin declares it on the VM as it does locally.
    mcpBehavior = (pluginRegistry.get('codex')!.behavior as { mcp?: typeof mcpBehavior }).mcp;

    const spec = await generateAgentLaunchSpec({
      ...baseParams,
      autoApprove: false,
      specialization: { model: 'gpt-5.6-terra' },
    });

    const content = spec.launchFiles![0].content;

    expect(content).toContain('model = "gpt-5.6-terra"');
    expect(content).not.toContain('mcp_servers');
    expect(content).not.toMatch(/Bearer |tok-/);
  });

  it('bakes a system prompt into the profile file rather than the argv', async () => {
    // The sidecar re-renders these args as a shell command line for the tmux
    // pane, so a free-form body there would be flattened or executed. It also
    // has to survive `resume`, which only inherits what the profile carries.
    mcpBehavior = (pluginRegistry.get('codex')!.behavior as { mcp?: typeof mcpBehavior }).mcp;
    const instructions = 'be terse\n$(whoami) and "quotes"';

    const spec = await generateAgentLaunchSpec({
      ...baseParams,
      autoApprove: false,
      specialization: { instructions },
    });

    const parsed = parseTOML(spec.launchFiles![0].content) as Record<string, unknown>;
    expect(spec.launchFiles).toHaveLength(1);
    expect(parsed.developer_instructions).toBe(instructions);
    expect(spec.launchFiles![0].homeRelativePath).not.toContain('instructions.md');
    // The profile name is digest-suffixed on (dir, slug); the file stem and the
    // --profile value must agree.
    const profileName = spec.launchFiles![0].homeRelativePath.replace(
      /^\.codex\/(.+)\.config\.toml$/,
      '$1'
    );
    expect(profileName).toMatch(/^hoot-[a-z0-9]+$/);
    expect(buildCommand).toHaveBeenCalledWith(
      expect.objectContaining({ agentArgs: ['--profile', profileName] })
    );
  });

  it('bakes no MCP args or launch files for a provider that resolves servers from config', async () => {
    const spec = await generateAgentLaunchSpec({ ...baseParams, autoApprove: false });

    expect(launchProfile).not.toHaveBeenCalled();
    expect(buildCommand).toHaveBeenCalledWith(expect.objectContaining({ agentArgs: [] }));
    expect(spec.launchFiles).toBeUndefined();
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
    autoApproveFlag: '-c approval_policy="never"',
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
        agentArgs: ['--profile', 'hoot'],
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
    expect(args).toContain('--profile');

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
        homeDir: '/home/agent',
      }
    );

    expect(cmd.args).toContain('hoot');
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
        homeDir: '/home/agent',
      }
    );

    expect(cmd.args).toContain('s1');
  });
});
