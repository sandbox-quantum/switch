export interface AgentHookEnv {
  port: number;
  ptyId: string;
  token: string;
  /**
   * Absolute path to the sidecar's endpoint file, when the session is served by
   * one. The generated hook command prefers the port/token in this file over the
   * baked env, so a pane keeps reaching its sidecar after that sidecar restarts
   * on a fresh port with a fresh token. Omitted for local sessions, whose hook
   * server dies with the app anyway.
   */
  endpointFile?: string;
}

/**
 * Environment that points an agent CLI's lifecycle hooks at a Switch Console hook
 * server (the local one for local sessions, the on-VM sidecar for remote ones)
 * and stands the in-session Switch connector's own poll loop down so it does
 * not race Switch Console's poller on the bridge's destructive event queue.
 *
 * Lives here rather than beside the PTY env allowlist so the remote sidecar —
 * which must bundle free of Electron and the database — shares this wiring
 * instead of re-inlining it. Every consumer of the hook protocol goes through
 * this one function: `buildAgentEnv` (local), the SSH agent runtime (remote,
 * UI-started), and the sidecar's own spawner (remote, auto-started).
 */
export function buildAgentHookEnv(hook: AgentHookEnv): Record<string, string> {
  return {
    SWITCHDASH_HOOK_PORT: String(hook.port),
    SWITCHDASH_PTY_ID: hook.ptyId,
    SWITCHDASH_HOOK_TOKEN: hook.token,
    SWITCH_CHANNEL_DISABLE_POLL: '1',
    ...(hook.endpointFile ? { SWITCHDASH_HOOK_ENDPOINT_FILE: hook.endpointFile } : {}),
  };
}
