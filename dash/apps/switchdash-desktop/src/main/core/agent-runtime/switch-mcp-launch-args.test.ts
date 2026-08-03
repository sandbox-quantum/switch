import type { PluginFs } from '@switchdash/core/agents/plugins';
import { pluginRegistry } from '@switchdash/plugins/agents';
import { describe, expect, it } from 'vitest';
import type { getPlugin } from '@main/core/providers/plugin-registry';
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

  it('folds per-agent specialization into the profile files', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      hasSwitchIdentity: true,
      specialization: { model: 'gpt-5.6-terra', reasoningEffort: 'high', instructions: 'be terse' },
    })!;
    expect(profile.files[0].content).toContain('model = "gpt-5.6-terra"');
    expect(profile.files[0].content).toContain('model_reasoning_effort = "high"');
    expect(profile.files).toHaveLength(2);
    expect(profile.files[1]).toEqual({
      relativePath: '.codex/codex-hoot.instructions.md',
      content: 'be terse',
    });
  });

  it('never puts a secret in the profile — the runtime reads its token from the env', () => {
    const profile = resolveSwitchLaunchProfile(codexPlugin, {
      slug: 'a',
      hasSwitchIdentity: true,
    })!;
    expect(profile.files[0].content).not.toMatch(/Bearer|SWITCH_API_TOKEN/);
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
