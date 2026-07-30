import {
  normalizeSwitchApiEndpoint,
  SWITCH_API_ENDPOINT_PLACEHOLDER,
} from '@shared/core/switch-rooms/switch-mcp-endpoint';

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
   * and {@link SWITCH_API_ENDPOINT_PLACEHOLDER} appear only for providers that take
   * those on argv, and are substituted when present.
   */
  args: string[];
  /** Base provider env (custom env + provider env); the per-spawn hook env is merged on top. */
  env: Record<string, string>;
  /** Absolute remote working dir the agent runs in (the agent's repo dir). */
  cwd: string;
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
 * the session id, initial prompt and Switch API endpoint into the spec's argv,
 * and merging the per-spawn env (hook env) over the base env.
 *
 * Throws if the prompt placeholder is missing: the prompt is what tells the
 * agent which room to connect to, so a spec that cannot carry it would spawn a
 * session that just sits there.
 *
 * The session id and endpoint tokens are substituted when present and are not
 * required. Not every provider takes a session id on a fresh session — Codex
 * mints its own rollout id and only accepts one when resuming — and switchdash
 * does not depend on the argv value either way: it correlates the spawn through
 * the pty id in the hook env, and learns the provider's own id from the
 * SessionStart hook. Likewise only providers that receive their MCP server on
 * argv emit an endpoint token.
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
    switchApiEndpoint: string | undefined;
  }
): MaterializedAgentCommand {
  const substitutions: Record<string, string> = {
    [SESSION_ID_PLACEHOLDER]: params.sessionId,
    [INITIAL_PROMPT_PLACEHOLDER]: params.initialPrompt,
  };

  if (!spec.args.includes(INITIAL_PROMPT_PLACEHOLDER)) {
    throw new Error(`agent launch spec is missing the ${INITIAL_PROMPT_PLACEHOLDER} argv token`);
  }

  const endpoint = normalizeSwitchApiEndpoint(params.switchApiEndpoint);
  const args = spec.args.map((arg) => {
    const whole = substitutions[arg];
    if (whole !== undefined) return whole;
    // The endpoint is embedded inside a larger argument, so it is replaced as a
    // substring rather than swapped for a whole argv element.
    return endpoint === null ? arg : arg.replaceAll(SWITCH_API_ENDPOINT_PLACEHOLDER, endpoint);
  });

  const unresolved = args.find((arg) => arg.includes(PLACEHOLDER_PREFIX));
  if (unresolved !== undefined) {
    throw new Error(`agent launch spec has an unsubstituted placeholder in argv: ${unresolved}`);
  }

  return { command: spec.command, args, env: { ...spec.env, ...params.extraEnv } };
}
