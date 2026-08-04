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
  it('returns a Codex profile registering the local stdio runtime, keyed on the slug', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
    });
    expect(profile).not.toBeNull();
    expect(profile!.files[0].relativePath).toBe('.codex/codex-hoot.config.toml');
    expect(profile!.args).toEqual(['--profile', 'codex-hoot']);
    expect(profile!.files[0].content).toContain('[mcp_servers.switch]');
    expect(profile!.files[0].content).toContain('command = "npx"');
    expect(profile!.files[0].content).toContain('@sandbox-quantum/switch-agent-runtime@');
  });

  it('folds per-agent specialization into the one profile file', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
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
      hasSwitchIdentity: true,
      specialization: { instructions: 'be terse\n$(whoami) "quoted"' },
    })!;

    expect(profile.args).toEqual(['--profile', 'codex-hoot']);
  });

  it('tells Codex which variables to route into the server it spawns', () => {
    // Codex gives an MCP child a fixed allowlist and nothing else, so a profile
    // that names none of these produces a runtime with no credentials — which
    // surfaces only as a closed connection during the handshake.
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
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
      resolveSwitchLaunchProfile(claudeLikePlugin, { slug: 'x', hasSwitchIdentity: true })
    ).toBeNull();
  });

  it('returns null when the session has no Switch identity', () => {
    expect(
      resolveSwitchLaunchProfile(codexPlugin, { slug: 'x', hasSwitchIdentity: false })
    ).toBeNull();
  });
});

describe('prepareSwitchMcpLaunch', () => {
  it('writes the profile under ~/.codex and returns the --profile argv', async () => {
    const fs = memoryFs();
    const args = await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
    });
    expect(args).toEqual(['--profile', 'codex-hoot']);
    expect(fs.files.get('.codex/codex-hoot.config.toml')).toContain('[mcp_servers.switch]');
  });

  it('writes the system prompt into the profile and no companion file', async () => {
    const fs = memoryFs();
    await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
      specialization: { instructions: 'be terse' },
    });

    expect([...fs.files.keys()]).toEqual(['.codex/codex-hoot.config.toml']);
    expect(fs.files.get('.codex/codex-hoot.config.toml')).toContain(
      'developer_instructions = "be terse"'
    );
  });

  it('writes nothing and returns [] when the session has no Switch identity', async () => {
    const fs = memoryFs();
    const args = await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'x',
      hasSwitchIdentity: false,
    });
    expect(args).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it('clears the pre-profile HTTP server, which would block the config from loading', async () => {
    // The base entry does not lose to the profile, it merges with it: `url`
    // meets `command` and Codex rejects the whole config, so every session
    // started with the profile dies, not only its Switch tools.
    const fs = memoryFs();
    fs.files.set(
      '.codex/config.toml',
      [
        'model = "gpt-5"',
        '',
        '[mcp_servers.switch]',
        'url = "https://switch.example.com/mcp/"',
        'bearer_token_env_var = "SWITCH_API_TOKEN"',
        '',
        '[mcp_servers.switch.tools.list_rooms]',
        'approval_mode = "approve"',
        '',
      ].join('\n')
    );

    await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
    });

    const base = fs.files.get('.codex/config.toml')!;
    expect(base).not.toContain('mcp_servers.switch');
    // Including the approval subtables: an entry with no transport of its own
    // is rejected in turn, so a partial removal is no repair at all.
    expect(base).not.toContain('approval_mode');
    expect(base).toContain('model = "gpt-5"');
  });

  it('leaves a stdio switch server the user defined themselves alone', async () => {
    const fs = memoryFs();
    fs.files.set(
      '.codex/config.toml',
      ['[mcp_servers.switch]', 'command = "my-own-switch"', ''].join('\n')
    );

    await prepareSwitchMcpLaunch(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
    });

    expect(fs.files.get('.codex/config.toml')).toContain('my-own-switch');
  });

  it('emits nothing for a provider that resolves MCP servers itself', async () => {
    const fs = memoryFs();
    expect(
      await prepareSwitchMcpLaunch(claudeLikePlugin, {
        homeFs: fs,
        slug: 'x',
        hasSwitchIdentity: true,
      })
    ).toEqual([]);
    expect(fs.files.size).toBe(0);
  });
});
