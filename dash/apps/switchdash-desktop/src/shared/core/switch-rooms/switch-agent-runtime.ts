/**
 * The published Switch agent-runtime package that serves the Switch MCP tools
 * over local stdio (transport to switch-core is HTTP+SSE, held inside the
 * runtime). The Claude Code connector plugin registers it from its bundled
 * `.mcp.json`; providers whose plugin cannot expand variables in a bundled
 * config — Codex — have switchdash register the same package itself at launch.
 *
 * Lives in `shared` so both halves of the remote path can reach it: the main
 * process bakes the launch recipe, and the on-VM sidecar (bundled free of
 * Electron and the database) spawns from it.
 */

/** npm package name of the local Switch MCP runtime. */
export const SWITCH_AGENT_RUNTIME_PACKAGE = '@sandbox-quantum/switch-agent-runtime';

/**
 * Exact version the runtime is pinned to. Must match the pin in
 * `connectors/claude-code-plugin/.mcp.json`; `switch-agent-runtime.test.ts`
 * fails if the two drift. Bump both together when the runtime is republished.
 */
export const SWITCH_AGENT_RUNTIME_VERSION = '0.1.2';

/** stdio command that launches the runtime with `npx`, resolving the pinned version. */
export type SwitchAgentRuntimeCommand = {
  command: string;
  args: string[];
};

/**
 * The stdio command that runs the pinned Switch MCP runtime. `npx -y` resolves
 * the package from the private registry the session env is already authenticated
 * against; credentials (`SWITCH_API_ENDPOINT` / `SWITCH_API_TOKEN` /
 * `SWITCH_AGENT_ID` / `SWITCH_CONNECTION_ID`) reach it through the inherited env,
 * so the command itself is static and carries no per-agent secret.
 */
export function switchAgentRuntimeCommand(): SwitchAgentRuntimeCommand {
  return {
    command: 'npx',
    args: ['-y', `${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`],
  };
}
