/**
 * A config file the sidecar must write on the VM before spawning, path relative
 * to the agent's home directory. Baked into the spec because the watcher is
 * provider-agnostic — it cannot build provider config itself, so switchdash
 * precomputes it. Used for Codex's per-agent profile registering the Switch MCP
 * runtime (`~/.codex/<slug>.config.toml`).
 */
export interface AgentLaunchFile {
  /** Path relative to the agent's home directory on the VM. */
  homeRelativePath: string;
  /** Full file content to write. */
  content: string;
}

/**
 * A serialised recipe for launching a fresh agent CLI session on the VM.
 *
 * The notification watcher runs headless on the VM with no access to
 * switchdash's plugin registry, so it cannot build a provider's launch command
 * itself. Instead switchdash precomputes the command once (via the provider
 * plugin's `buildCommand`) with placeholder tokens standing in for the two
 * per-spawn values — the session id and the initial prompt — and writes
 * this spec to the VM. The watcher then substitutes those tokens per spawn, so
 * all provider knowledge stays in switchdash and the watcher is provider
 * agnostic.
 */
export interface AgentLaunchSpec {
  /** Executable to run (absolute path resolved on the host at deploy time). */
  command: string;
  /**
   * Argv for a fresh session. One element equals {@link INITIAL_PROMPT_PLACEHOLDER};
   * the watcher swaps it for the real prompt per spawn. {@link SESSION_ID_PLACEHOLDER}
   * appears only for providers that take it on argv, and is substituted when present.
   */
  args: string[];
  /** Base provider env (custom env + provider env); the per-spawn hook env is merged on top. */
  env: Record<string, string>;
  /** Absolute remote working dir the agent runs in (the agent's repo dir). */
  cwd: string;
  /**
   * Home-relative config files the sidecar writes before spawning, e.g. Codex's
   * per-agent profile. Static across spawns, so the watcher writes them verbatim.
   */
  launchFiles?: AgentLaunchFile[];
  providerId: string;
  deeplinkScheme: string;
}

/** Argv token switchdash emits in place of the fresh session's session id. */
export const SESSION_ID_PLACEHOLDER = '__SWITCHDASH_SESSION_ID__';

/** Argv token switchdash emits in place of the fresh session's initial prompt. */
export const INITIAL_PROMPT_PLACEHOLDER = '__SWITCHDASH_INITIAL_PROMPT__';

/** Shared prefix of every launch-spec placeholder, used to catch leftovers. */
const PLACEHOLDER_PREFIX = '__SWITCHDASH_';

export interface MaterializedAgentCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Resolve a launch spec into a concrete command for one spawn by substituting
 * the session id and initial prompt into the spec's argv, and merging the
 * per-spawn env (hook env) over the base env.
 *
 * Throws if the prompt placeholder is missing: the prompt is what tells the
 * agent which room to connect to, so a spec that cannot carry it would spawn a
 * session that just sits there.
 *
 * The session id token is substituted when present and is not required. Not
 * every provider takes a session id on a fresh session — Codex mints its own
 * rollout id and only accepts one when resuming — and switchdash does not depend
 * on the argv value either way: it correlates the spawn through the pty id in the
 * hook env, and learns the provider's own id from the SessionStart hook. The
 * Switch MCP server no longer rides argv; the runtime reads its endpoint and
 * credentials from the env, and Codex loads it from a baked profile
 * ({@link AgentLaunchSpec.launchFiles}).
 *
 * Throws if any `__SWITCHDASH_` token survives substitution, so a provider that
 * grows a new placeholder cannot quietly launch an agent pointed at literal
 * placeholder text.
 */
export function materializeAgentCommand(
  spec: AgentLaunchSpec,
  params: {
    sessionId: string;
    initialPrompt: string;
    extraEnv: Record<string, string>;
  }
): MaterializedAgentCommand {
  const substitutions: Record<string, string> = {
    [SESSION_ID_PLACEHOLDER]: params.sessionId,
    [INITIAL_PROMPT_PLACEHOLDER]: params.initialPrompt,
  };

  if (!spec.args.includes(INITIAL_PROMPT_PLACEHOLDER)) {
    throw new Error(`agent launch spec is missing the ${INITIAL_PROMPT_PLACEHOLDER} argv token`);
  }

  const args = spec.args.map((arg) => substitutions[arg] ?? arg);

  const unresolved = args.find((arg) => arg.includes(PLACEHOLDER_PREFIX));
  if (unresolved !== undefined) {
    throw new Error(`agent launch spec has an unsubstituted placeholder in argv: ${unresolved}`);
  }

  return { command: spec.command, args, env: { ...spec.env, ...params.extraEnv } };
}
