import type { SwitchLaunchProfile, SwitchMcpLaunchServer } from '@switchdash/core/agents/plugins';
import { stringify as stringifyTOML } from 'smol-toml';

/**
 * MCP server name the Switch tools are registered under inside a Codex profile.
 * Codex loads a profile's `[mcp_servers.*]` at runtime and it cleanly overrides
 * a same-named server in the base `~/.codex/config.toml`, so this name is safe
 * even when a user already defines their own `switch` server.
 */
export const CODEX_PROFILE_SWITCH_SERVER_NAME = 'switch';

/**
 * An agent's profile path relative to the user's home, loaded via
 * `--profile <slug>`. Codex resolves a profile at `$CODEX_HOME/<slug>.config.toml`
 * with CODEX_HOME defaulting to `~/.codex`; switchdash writes (like the Codex
 * hooks it installs at `~/.codex/hooks.json`) under `~/.codex`, so an agent that
 * overrides CODEX_HOME is out of scope here as it is for hooks.
 */
export function codexProfileRelativePath(slug: string): string {
  return `.codex/${slug}.config.toml`;
}

/**
 * Render an agent's Codex profile as TOML. A profile is layered on top of the
 * user's base `~/.codex/config.toml` via `--profile <slug>`; it carries only
 * what switchdash owns per agent, leaving the user's model/provider/auth intact.
 */
export function buildCodexProfileToml(inputs: { switchServer: SwitchMcpLaunchServer }): string {
  const profile: Record<string, unknown> = {
    mcp_servers: {
      [CODEX_PROFILE_SWITCH_SERVER_NAME]: {
        command: inputs.switchServer.command,
        args: inputs.switchServer.args,
      },
    },
  };

  return stringifyTOML(profile);
}

/**
 * Compute an agent's Codex launch profile: the file to write under `~/.codex`
 * and the `--profile <slug>` argv that loads it. Pure — the caller writes the
 * file — so it serves both a direct write (local/SSH) and a launch spec the VM
 * sidecar writes. Returns `null` when there is no Switch identity to register.
 */
export function codexLaunchProfile(params: {
  slug: string;
  switchServer: SwitchMcpLaunchServer | null;
}): SwitchLaunchProfile | null {
  if (!params.switchServer) return null;

  return {
    relativePath: codexProfileRelativePath(params.slug),
    content: buildCodexProfileToml({ switchServer: params.switchServer }),
    args: ['--profile', params.slug],
  };
}
