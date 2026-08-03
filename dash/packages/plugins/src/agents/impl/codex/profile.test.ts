import { parse as parseTOML } from 'smol-toml';
import { describe, expect, it } from 'vitest';
import {
  buildCodexProfileToml,
  CODEX_PROFILE_SWITCH_SERVER_NAME,
  codexLaunchProfile,
  codexProfileRelativePath,
} from './profile';

const runtime = { command: 'npx', args: ['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2'] };

describe('buildCodexProfileToml', () => {
  it('registers the Switch runtime as a stdio server with no inline secret', () => {
    const parsed = parseTOML(buildCodexProfileToml({ switchServer: runtime })) as {
      mcp_servers: Record<string, { command: string; args: string[] }>;
    };

    expect(parsed.mcp_servers[CODEX_PROFILE_SWITCH_SERVER_NAME]).toEqual({
      command: 'npx',
      args: ['-y', '@sandbox-quantum/switch-agent-runtime@0.1.2'],
    });
    expect(JSON.stringify(parsed)).not.toMatch(/Bearer|SWITCH_API_TOKEN/);
  });
});

describe('codexLaunchProfile', () => {
  it('writes under ~/.codex keyed on the slug and loads with --profile', () => {
    const profile = codexLaunchProfile({ slug: 'codex-hoot', switchServer: runtime });
    expect(profile).not.toBeNull();
    expect(profile!.relativePath).toBe(codexProfileRelativePath('codex-hoot'));
    expect(profile!.relativePath).toBe('.codex/codex-hoot.config.toml');
    expect(profile!.args).toEqual(['--profile', 'codex-hoot']);
    expect(profile!.content).toContain('[mcp_servers.switch]');
  });

  it('returns null when there is no Switch identity to register', () => {
    expect(codexLaunchProfile({ slug: 'codex-hoot', switchServer: null })).toBeNull();
  });
});
