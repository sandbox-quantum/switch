/**
 * A Switch agent discovered from a directory's Claude Code settings.
 *
 * Switch Console is a local orchestrator: it only needs to *detect* that a
 * directory is configured as a Switch agent and learn the agent's identity for
 * display/grouping. The `claude` CLI self-loads the `SWITCH_*` env block from
 * the directory's settings on launch, so Switch Console never has to hold the
 * `SWITCH_API_TOKEN` itself — and intentionally does not retain it.
 */
export interface SwitchAgentConfig {
  /** `SWITCH_AGENT_ID` — the agent's stable identity in Switch. */
  agentId: string;
  /** `SWITCH_API_ENDPOINT` — used only for display/grouping, not for calls. */
  apiEndpoint: string;
  /** Absolute path to the agent's working directory (1:1 with the agent). */
  dir: string;
}
