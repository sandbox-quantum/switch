import type { PluginFs } from '@switchdash/core/agents/plugins';
import { pluginRegistry } from '@switchdash/plugins/agents';
import { describe, expect, it } from 'vitest';
import type { getPlugin } from '@main/core/providers/plugin-registry';
import { prepareAgentLaunchProfile, resolveAgentLaunchProfile } from './agent-launch-profile';

type Plugin = ReturnType<typeof getPlugin>;

/** The real Codex plugin — the only one that takes specialization from a file. */
const codexPlugin = pluginRegistry.get('codex')! as unknown as Plugin;

/** A provider that takes its specialization on argv, as Claude's does. */
const claudeLikePlugin = { behavior: { mcp: {} } } as unknown as Plugin;

/** An agent working directory; folded into the profile name for uniqueness. */
const WD = '/home/agent/repo';

/** The profile filename stem is the `--profile` value; assert they agree. */
const PROFILE_STEM = /^codex-hoot-[a-z0-9]+$/;

const SPECIALIZED = { model: 'gpt-5.6-terra' };

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

describe('resolveAgentLaunchProfile', () => {
  it('returns a Codex profile keyed on the (dir, slug)', () => {
    const profile = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      specialization: SPECIALIZED,
    });
    expect(profile).not.toBeNull();
    // The --profile value and the file stem are the same digest-suffixed name.
    expect(profile!.args[0]).toBe('--profile');
    expect(profile!.args[1]).toMatch(PROFILE_STEM);
    expect(profile!.files[0].relativePath).toBe(`.codex/${profile!.args[1]}.config.toml`);
  });

  it('registers no MCP server — the connector plugin ships that', () => {
    // The Switch server lives in the plugin's bundled `.mcp.json`, so a session
    // has it whether or not switchdash launched it. Writing it here as well
    // would restrict nothing and duplicate the declaration.
    const profile = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      specialization: SPECIALIZED,
    })!;

    expect(profile.files[0].content).not.toContain('mcp_servers');
    expect(profile.files[0].content).not.toContain('switch-agent-runtime');
  });

  it('gives two agents that share a name in different dirs distinct profiles', () => {
    const a = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: '/dir/one',
      specialization: SPECIALIZED,
    })!;
    const b = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: '/dir/two',
      specialization: SPECIALIZED,
    })!;
    expect(a.args).not.toEqual(b.args);
    expect(a.files[0].relativePath).not.toBe(b.files[0].relativePath);
  });

  it('folds per-agent specialization into the one profile file', () => {
    const profile = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
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
    const profile = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'codex-hoot',
      workingDir: WD,
      specialization: { instructions: 'be terse\n$(whoami) "quoted"' },
    })!;

    expect(profile.args[0]).toBe('--profile');
    expect(profile.args[1]).toMatch(PROFILE_STEM);
    expect(profile.args.join(' ')).not.toContain('whoami');
  });

  it('carries no credential, so the profile is safe to bake and ship to a VM', () => {
    const profile = resolveAgentLaunchProfile(codexPlugin, {
      slug: 'a',
      workingDir: WD,
      specialization: SPECIALIZED,
    })!;

    expect(profile.files[0].content).not.toMatch(/Bearer /);
    expect(profile.files[0].content).not.toContain('SWITCH_API_TOKEN');
  });

  it('returns null when the provider takes its specialization another way', () => {
    expect(
      resolveAgentLaunchProfile(claudeLikePlugin, {
        slug: 'x',
        workingDir: WD,
        specialization: SPECIALIZED,
      })
    ).toBeNull();
  });

  it('returns null when there is nothing to specialize', () => {
    // Previously a profile was written for the MCP registration alone. With that
    // gone, an agent on the defaults needs no file and no `--profile` argv.
    expect(resolveAgentLaunchProfile(codexPlugin, { slug: 'x', workingDir: WD })).toBeNull();
  });
});

describe('prepareAgentLaunchProfile', () => {
  it('writes the profile under ~/.codex and returns the --profile argv', async () => {
    const fs = memoryFs();
    const args = await prepareAgentLaunchProfile(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      workingDir: WD,
      specialization: SPECIALIZED,
    });
    expect(args[1]).toMatch(PROFILE_STEM);
    expect(fs.files.get(`.codex/${args[1]}.config.toml`)).toContain('model = "gpt-5.6-terra"');
  });

  it('writes the system prompt into the profile and no companion file', async () => {
    const fs = memoryFs();
    const args = await prepareAgentLaunchProfile(codexPlugin, {
      homeFs: fs,
      slug: 'codex-hoot',
      workingDir: WD,
      specialization: { instructions: 'be terse' },
    });

    expect([...fs.files.keys()]).toEqual([`.codex/${args[1]}.config.toml`]);
    expect(fs.files.get(`.codex/${args[1]}.config.toml`)).toContain(
      'developer_instructions = "be terse"'
    );
  });

  it('writes nothing and returns [] for an agent that specializes nothing', async () => {
    const fs = memoryFs();
    const args = await prepareAgentLaunchProfile(codexPlugin, {
      homeFs: fs,
      slug: 'x',
      workingDir: WD,
    });
    expect(args).toEqual([]);
    expect(fs.files.size).toBe(0);
  });

  it('emits nothing for a provider that needs no launch file', async () => {
    const fs = memoryFs();
    expect(
      await prepareAgentLaunchProfile(claudeLikePlugin, {
        homeFs: fs,
        slug: 'x',
        workingDir: WD,
        specialization: SPECIALIZED,
      })
    ).toEqual([]);
    expect(fs.files.size).toBe(0);
  });
});
