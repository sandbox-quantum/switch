/**
 * A serialised recipe for launching a fresh agent CLI session on the VM.
 *
 * The notification watcher runs headless on the VM with no access to
 * switchdash's plugin registry, so it cannot build a provider's launch command
 * itself. Instead switchdash precomputes the command once (via the provider
 * plugin's `buildCommand`) with placeholder tokens standing in for the two
 * per-spawn values — the conversation id and the initial prompt — and writes
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

/** Argv token switchdash emits in place of the fresh session's conversation id. */
export const SESSION_ID_PLACEHOLDER = '__SWITCHDASH_SESSION_ID__';

/** Argv token switchdash emits in place of the fresh session's initial prompt. */
export const INITIAL_PROMPT_PLACEHOLDER = '__SWITCHDASH_INITIAL_PROMPT__';

export interface MaterializedAgentCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Resolve a launch spec into a concrete command for one spawn by substituting
 * the session id and initial prompt into the placeholder argv elements and
 * merging the per-spawn env (hook env) over the base env.
 *
 * Throws if either placeholder is missing from the spec's argv — a spec that
 * cannot carry the conversation id or prompt would silently spawn a session
 * that never connects to the room, so we fail loud instead.
 */
export function materializeAgentCommand(
  spec: AgentLaunchSpec,
  params: { sessionId: string; initialPrompt: string; extraEnv: Record<string, string> }
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

  const args = spec.args.map((arg) => substitutions[arg] ?? arg);
  return { command: spec.command, args, env: { ...spec.env, ...params.extraEnv } };
}
