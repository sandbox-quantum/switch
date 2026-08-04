import type {
  SwitchLaunchProfile,
  SwitchLaunchSpecialization,
  SwitchMcpLaunchServer,
} from '@switchdash/core/agents/plugins';
import { stringify as stringifyTOML } from 'smol-toml';

/**
 * MCP server name the Switch tools are registered under inside a Codex profile.
 *
 * A profile does NOT replace a same-named server in the base
 * `~/.codex/config.toml` — Codex deep-merges the two tables. So a base entry
 * declaring a different transport (an `url` from the pre-profile registration)
 * merges with this one's `command`/`args` into a server that is both, and Codex
 * refuses to load the config at all: "url is not supported for stdio in
 * `mcp_servers.switch`". That kills every session launched with the profile,
 * not just its Switch tooling. A base `[mcp_servers.switch]` must therefore be
 * removed — including its `tools.*` approval subtables, since a base entry with
 * no transport of its own is itself rejected ("invalid transport").
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
 * How long Codex waits for the Switch MCP server to complete its handshake.
 *
 * Codex allows 10 seconds by default, which a host that has never run the
 * runtime can exceed on the `npx` fetch alone — the package comes from a
 * private registry — before the server has done any work of its own. A timeout
 * there is indistinguishable from a broken server, so the budget is set well
 * clear of a cold start rather than close to a warm one.
 */
export const CODEX_MCP_STARTUP_TIMEOUT_SEC = 60;

/**
 * The profile name an agent's slug maps to. Codex rejects anything outside
 * `[A-Za-z0-9_-]` in `--profile` ("pass a plain name such as `work`"), while a
 * Switch agent name is dotted — `codex.yak.cmcdermott` — so the slug cannot be
 * used verbatim. An already-valid slug is returned untouched; a rewritten one
 * carries a digest of the original so two agents differing only in the rewritten
 * characters (`a.b` vs `a-b`) cannot collide onto one profile.
 */
export function codexProfileName(slug: string): string {
  const plain = slug.replace(/[^A-Za-z0-9_-]/g, '-');
  return plain === slug ? plain : `${plain}-${slugDigest(slug)}`;
}

/** FNV-1a over the raw slug, base36 — short, stable, and dependency-free. */
function slugDigest(slug: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < slug.length; i++) {
    hash = Math.imul(hash ^ slug.charCodeAt(i), 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * An agent's profile path relative to the user's home, loaded via
 * `--profile <name>`. Codex resolves a profile at `$CODEX_HOME/<name>.config.toml`
 * with CODEX_HOME defaulting to `~/.codex`; switchdash writes (like the Codex
 * hooks it installs at `~/.codex/hooks.json`) under `~/.codex`, so an agent that
 * overrides CODEX_HOME is out of scope here as it is for hooks.
 */
export function codexProfileRelativePath(slug: string): string {
  return `.codex/${codexProfileName(slug)}.config.toml`;
}

export type CodexProfileInputs = {
  switchServer: SwitchMcpLaunchServer | null;
} & SwitchLaunchSpecialization;

/**
 * Render an agent's Codex profile as TOML. A profile is layered on top of the
 * user's base `~/.codex/config.toml` via `--profile <slug>`; it carries only
 * what switchdash owns per agent, leaving the user's provider/auth intact.
 *
 * A per-agent system prompt rides `developer_instructions`, which Codex
 * *appends* to its own operating manual as an extra developer message. The
 * alternative, `model_instructions_file`, **replaces** that manual outright:
 * measured against codex-cli 0.146.0, a request whose baseline `instructions`
 * is 20,751 characters (the exec/apply_patch protocol, sandbox escalation, the
 * planning tool, final-answer formatting) drops to the file's length alone, so
 * an agent given a one-line prompt loses every rule it needs to act. The body
 * belongs in the TOML rather than on argv: TOML escaping is lossless for
 * multi-line text, while argv is re-quoted into a shell command for the SSH and
 * tmux launch paths, where `$(…)` and backticks would be substituted and
 * newlines flattened.
 */
export function buildCodexProfileToml(inputs: CodexProfileInputs): string {
  const profile: Record<string, unknown> = {};

  if (inputs.model) profile.model = inputs.model;
  if (inputs.reasoningEffort) profile.model_reasoning_effort = inputs.reasoningEffort;
  if (inputs.instructions) profile.developer_instructions = inputs.instructions;

  if (inputs.switchServer) {
    profile.mcp_servers = {
      [CODEX_PROFILE_SWITCH_SERVER_NAME]: {
        command: inputs.switchServer.command,
        args: inputs.switchServer.args,
        // Codex hands an MCP server a fixed allowlist (HOME, PATH, SHELL, …)
        // rather than its own environment, so a server that names nothing runs
        // with no credentials at all.
        ...(inputs.switchServer.envVars.length > 0
          ? { env_vars: inputs.switchServer.envVars }
          : {}),
        startup_timeout_sec: CODEX_MCP_STARTUP_TIMEOUT_SEC,
      },
    };
  }

  return stringifyTOML(profile);
}

/**
 * Compute an agent's Codex launch profile: the file to write under `~/.codex`
 * and the `--profile <slug>` argv that loads it. Pure — the caller writes the
 * file — so it serves both a direct write (local/SSH) and a launch spec the VM
 * sidecar writes. Returns `null` when there is nothing to register or specialize.
 *
 * Every per-agent value lives in the file; the argv is two fixed tokens. That
 * is what keeps free-form user text off a command line that the SSH and tmux
 * paths re-render as a shell string, and it is what lets `codex resume` inherit
 * the same specialization as a fresh launch.
 */
export function codexLaunchProfile(
  params: { slug: string } & CodexProfileInputs
): SwitchLaunchProfile | null {
  const { slug, ...inputs } = params;
  if (!inputs.switchServer && !inputs.model && !inputs.reasoningEffort && !inputs.instructions) {
    return null;
  }

  return {
    files: [
      { relativePath: codexProfileRelativePath(slug), content: buildCodexProfileToml(inputs) },
    ],
    args: ['--profile', codexProfileName(slug)],
  };
}
