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
   * Argv for a fresh session. Exactly one element equals
   * {@link SESSION_ID_PLACEHOLDER} and one equals {@link INITIAL_PROMPT_PLACEHOLDER};
   * the watcher swaps those for the real values per spawn.
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
 * Throws if the session id or prompt placeholder is missing from the spec's
 * argv — a spec that cannot carry them would silently spawn a session that
 * never connects to the room, so we fail loud instead. The endpoint token is
 * optional: only providers that receive their MCP server on argv emit one.
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

  for (const placeholder of [SESSION_ID_PLACEHOLDER, INITIAL_PROMPT_PLACEHOLDER]) {
    if (!spec.args.includes(placeholder)) {
      throw new Error(`agent launch spec is missing the ${placeholder} argv token`);
    }
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
