import { parse as parseTOML } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  buildCodexProfileToml,
  CODEX_PROFILE_SWITCH_SERVER_NAME,
  CODEX_REASONING_EFFORTS,
  codexInstructionsRelativePath,
  codexLaunchProfile,
  codexProfileRelativePath,
} from './profile';

const runtime = { command: 'npx', args: ['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2'] };

describe('buildCodexProfileToml', () => {
  it('registers the Switch runtime as a stdio server with no inline secret', () => {
    const parsed = parseTOML(buildCodexProfileToml('codex-hoot', { switchServer: runtime })) as {
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };

    expect(parsed.mcp_servers[CODEX_PROFILE_SWITCH_SERVER_NAME]).toEqual({
      command: 'npx',
      args: ['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2'],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Bearer|SWITCH_API_TOKEN/);
  });

  it('emits model / effort scalars and a CODEX_HOME-relative instructions reference', () => {
    const parsed = parseTOML(
      buildCodexProfileToml('codex-hoot', {
        switchServer: runtime,
        model: 'gpt-5.6-terra',
        reasoningEffort: 'high',
        instructions: 'be terse',
      })
    ) as Record<string, unknown>;

    expect(parsed.model).toBe('gpt-5.6-terra');
    expect(parsed.model_reasoning_effort).toBe('high');
    // Relative to CODEX_HOME, so a baked profile needs no absolute VM path.
    expect(parsed.model_instructions_file).toBe('codex-hoot.instructions.md');
  });

  it('omits unset specialization keys so the base config default is inherited', () => {
    const parsed = parseTOML(buildCodexProfileToml('a', { switchServer: runtime })) as Record<
      string,
      unknown
    >;
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_reasoning_effort).toBeUndefined();
    expect(parsed.model_instructions_file).toBeUndefined();
  });
});

describe('codexLaunchProfile', () => {
  it('writes the profile under ~/.codex keyed on the slug and loads with --profile', () => {
    const profile = codexLaunchProfile({ slug: 'codex-hoot', switchServer: runtime });
    expect(profile).not.toBeNull();
    expect(profile!.args).toEqual(['--profile', 'codex-hoot']);
    expect(profile!.files).toEqual([
      {
        relativePath: codexProfileRelativePath('codex-hoot'),
        content: expect.stringContaining('[mcp_servers.switch]'),
      },
    ]);
    expect(codexProfileRelativePath('codex-hoot')).toBe('.codex/codex-hoot.config.toml');
  });

  it('adds a second instructions file when a system prompt is set', () => {
    const profile = codexLaunchProfile({
      slug: 'codex-hoot',
      switchServer: runtime,
      instructions: 'you are terse',
    })!;
    expect(profile.files).toHaveLength(2);
    expect(profile.files[1]).toEqual({
      relativePath: codexInstructionsRelativePath('codex-hoot'),
      content: 'you are terse',
    });
    expect(codexInstructionsRelativePath('codex-hoot')).toBe('.codex/codex-hoot.instructions.md');
  });

  it('returns a profile for specialization even without a Switch identity', () => {
    const profile = codexLaunchProfile({ slug: 'a', switchServer: null, model: 'gpt-5.6-terra' });
    expect(profile).not.toBeNull();
    expect(profile!.files[0].content).toContain('model = "gpt-5.6-terra"');
    expect(profile!.files[0].content).not.toContain('mcp_servers');
  });

  it('returns null when there is nothing to register or specialize', () => {
    expect(codexLaunchProfile({ slug: 'a', switchServer: null })).toBeNull();
  });

  it('exposes the stable reasoning-effort levels', () => {
    expect(CODEX_REASONING_EFFORTS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});
