import type {
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
  SwitchMcpLaunchServer,
} from '@switchdash/core/agents/plugins';
import { stringify as stringifyTOML } from 'smol-toml';

/**
 * MCP server name the Switch tools are registered under inside a Codex profile.
 * Codex loads a profile's `[mcp_servers.*]` at runtime and it cleanly overrides
 * a same-named server in the base `~/.codex/config.toml`, so this name is safe
 * even when a user already defines their own `switch` server.
 */
export const CODEX_PROFILE_SWITCH_SERVER_NAME = 'switch';

/**
 * Reasoning-effort levels Codex accepts for `model_reasoning_effort`, in
 * ascending order. Stable across model catalog changes (unlike the model list),
 * so they are declared here and drive the per-agent effort picker; a model that
 * does not support the highest tiers simply ignores them. Empty string = leave
 * the base config's default.
 */
export const CODEX_REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

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

/** The per-agent instructions file, relative to the user's home. */
export function codexInstructionsRelativePath(slug: string): string {
  return `.codex/${slug}.instructions.md`;
}

/**
 * The instructions file path as Codex reads it — relative to CODEX_HOME
 * (`~/.codex`), where `model_instructions_file` is resolved. Kept relative so a
 * baked profile needs no knowledge of the VM's absolute home.
 */
function instructionsFileForProfile(slug: string): string {
  return `${slug}.instructions.md`;
}

export type CodexProfileInputs = {
  switchServer: SwitchMcpLaunchServer | null;
} & SwitchLaunchSpecialization;

/**
 * Render an agent's Codex profile as TOML. A profile is layered on top of the
 * user's base `~/.codex/config.toml` via `--profile <slug>`; it carries only
 * what switchdash owns per agent, leaving the user's provider/auth intact.
 * `model` / `model_reasoning_effort` are scalar overrides; a system prompt is
 * referenced as `model_instructions_file` and written as a separate file.
 */
export function buildCodexProfileToml(slug: string, inputs: CodexProfileInputs): string {
  const profile: Record<string, unknown> = {};

  if (inputs.model) profile.model = inputs.model;
  if (inputs.reasoningEffort) profile.model_reasoning_effort = inputs.reasoningEffort;
  if (inputs.instructions) profile.model_instructions_file = instructionsFileForProfile(slug);

  if (inputs.switchServer) {
    profile.mcp_servers = {
      [CODEX_PROFILE_SWITCH_SERVER_NAME]: {
        command: inputs.switchServer.command,
        args: inputs.switchServer.args,
      },
    };
  }

  return stringifyTOML(profile);
}

/**
 * Compute an agent's Codex launch profile: the files to write under `~/.codex`
 * (the profile, plus an instructions file when a system prompt is set) and the
 * `--profile <slug>` argv that loads them. Pure — the caller writes the files —
 * so it serves both a direct write (local/SSH) and a launch spec the VM sidecar
 * writes. Returns `null` when there is nothing to register or specialize.
 */
export function codexLaunchProfile(
  params: { slug: string } & CodexProfileInputs
): SwitchLaunchProfile | null {
  const { slug, ...inputs } = params;
  if (!inputs.switchServer && !inputs.model && !inputs.reasoningEffort && !inputs.instructions) {
    return null;
  }

  const files = [
    { relativePath: codexProfileRelativePath(slug), content: buildCodexProfileToml(slug, inputs) },
  ];
  if (inputs.instructions) {
    files.push({
      relativePath: codexInstructionsRelativePath(slug),
      content: inputs.instructions,
    });
  }

  return { files, args: ['--profile', slug] };
}
