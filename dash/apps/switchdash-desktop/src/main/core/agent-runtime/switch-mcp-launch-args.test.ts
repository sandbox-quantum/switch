import type { PluginFs } from '@switchdash/core/agents/plugins';
import { pluginRegistry } from '@switchdash/plugins/agents';
import { parse as parseTOML } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { switchAgentRuntimeCommand } from '@shared/core/switch-rooms/switch-agent-runtime';
import { prepareSwitchMcpLaunch, resolveSwitchLaunchProfile } from './switch-mcp-launch-args';

type Plugin = ReturnType<typeof getPlugin>;

/** The real Codex plugin — it registers the Switch server via a profile. */
const codexPlugin = pluginRegistry.get('codex')! as unknown as Plugin;

/** A provider whose connector resolves MCP servers itself, as Claude's does. */
const claudeLikePlugin = { behavior: { mcp: {} } } as unknown as Plugin;

/** An agent working directory; folded into the profile name for uniqueness. */
const WD = '/home/agent/repo';

/** The profile filename stem is the `--profile` value; assert they agree. */
const PROFILE_STEM = /^codex-hoot-[a-z0-9]+$/;

function memoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    async read(p) {
      return files.get(p) ?? null;
    },
    async write(p, c) {
      files.set(p, c);
    },
    async delete(p) {
      files.delete(p);
    },
    async exists(p) {
      return files.has(p);
    },
    async list() {
      return [];
    },
  };
}

describe('resolveSwitchLaunchProfile', () => {
  it('returns a Codex profile registering the local stdio runtime, keyed on the (dir, slug)', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
    });
    expect(profile).not.toBeNull();
    // The --profile value and the file stem are the same digest-suffixed name.
    expect(profile!.args[0]).toBe('--profile');
    expect(profile!.args[1]).toMatch(PROFILE_STEM);
    expect(profile!.files[0].relativePath).toBe(`.codex/${profile!.args[1]}.config.toml`);
    expect(profile!.files[0].content).toContain('[mcp_servers.switch]');
    expect(profile!.files[0].content).toContain('command = "npx"');
    expect(profile!.files[0].content).toContain('@sandbox-quantum/switch-agent-runtime@');
  });

  it('gives two agents that share a name in different dirs distinct profiles', () => {
    const a = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: '/dir/one',
      hasSwitchIdentity: true,
    })!;
    const b = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: '/dir/two',
      hasSwitchIdentity: true,
    })!;
    expect(a.args).not.toEqual(b.args);
    expect(a.files[0].relativePath).not.toBe(b.files[0].relativePath);
  });

  it('folds per-agent specialization into the one profile file', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
      specialization: { model: 'gpt-5.6-terra', reasoningEffort: 'high', instructions: 'be terse' },
    })!;
    expect(profile.files).toHaveLength(1);
    expect(profile.files[0].content).toContain('model = "gpt-5.6-terra"');
    expect(profile.files[0].content).toContain('model_reasoning_effort = "high"');
    // Additive: an instructions *file* would replace Codex's own operating
    // manual, leaving the agent without the protocol it needs to act.
    expect(profile.files[0].content).toContain('developer_instructions = "be terse"');
    expect(profile.files[0].content).not.toContain('model_instructions_file');
  });

  it('keeps the system prompt out of the argv the SSH and tmux paths re-quote', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
      specialization: { instructions: 'be terse\n$(whoami) "quoted"' },
    })!;

    expect(profile.args[0]).toBe('--profile');
    expect(profile.args[1]).toMatch(PROFILE_STEM);
    expect(profile.args.join(' ')).not.toContain('whoami');
  });

  it('tells Codex which variables to route into the server it spawns', () => {
    // Codex gives an MCP child a fixed allowlist and nothing else, so a profile
    // that names none of these produces a runtime with no credentials — which
    // surfaces only as a closed connection during the handshake.
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
    })!;
    const server = (
      parseTOML(profile.files[0].content) as {
        mcp_servers: Record<string, { env_vars?: string[] }>;
      }
    ).mcp_servers.switch;

    expect(server.env_vars).toEqual(switchAgentRuntimeCommand().envVars);
  });

  it('names the credentials without carrying them, so the profile is safe to bake and ship', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'a',
      workingDir: WD,
      hasSwitchIdentity: true,
    })!;
    const server = (
      parseTOML(profile.files[0].content) as {
        mcp_servers: Record<string, { env?: unknown; bearer_token?: unknown; env_vars?: string[] }>;
      }
    ).mcp_servers.switch;

    expect(server.env).toBeUndefined();
    expect(server.bearer_token).toBeUndefined();
    for (const name of server.env_vars ?? []) {
      expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    }
    expect(profile.files[0].content).not.toMatch(/Bearer /);
  });

  it('returns null when the provider resolves MCP servers some other way', () => {
    expect(
      resolveSwitchLaunchProfile(claudeLikePlugin, {
        slug: 'x',
        workingDir: WD,
        hasSwitchIdentity: true,
      })
    ).toBeNull();
  });

  it('returns null when the session has no Switch identity', () => {
    expect(
      resolveSwitchLaunchProfile(codexPlugin, {
        slug: 'x',
        workingDir: WD,
        hasSwitchIdentity: false,
      })
    ).toBeNull();
  });
});

describe('prepareSwitchMcpLaunch', () => {
  it('writes the profile under ~/.codex and returns the --profile argv', async () => {
    const fs = memoryFs();
    const args = await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
    });
    expect(args[1]).toMatch(PROFILE_STEM);
    expect(fs.files.get(`.codex/${args[1]}.config.toml`)).toContain('[mcp_servers.switch]');
  });

  it('writes the system prompt into the profile and no companion file', async () => {
    const fs = memoryFs();
    const args = await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      workingDir: WD,
      hasSwitchIdentity: true,
      specialization: { instructions: 'be terse' },
    });

    expect([...fs.files.keys()]).toEqual([`.codex/${args[1]}.config.toml`]);
    expect(fs.files.get(`.codex/${args[1]}.config.toml`)).toContain(
      'developer_instructions = "be terse"'
    );
  });

  it('writes nothing and returns [] when the session has no Switch identity', async () => {
    const fs = memoryFs();
    const args = await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'x',
      workingDir: WD,
      hasSwitchIdentity: false,
    });
    expect(args).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it('emits nothing for a provider that resolves MCP servers itself', async () => {
    const fs = memoryFs();
    expect(
      await prepareSwitchMcpLaunch(claudeLikePlugin, {
        homeFs: fs,
        slug: 'x',
        workingDir: WD,
        hasSwitchIdentity: true,
      })
    ).toEqual([]);
    expect(fs.files.size).toBe(0);
  });
});
