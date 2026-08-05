/**
 * The published Switch agent-runtime package that serves the Switch MCP tools
 * over local stdio (transport to switch-core is HTTP+SSE, held inside the
 * runtime). Both connector plugins register it from a bundled `.mcp.json`: the
 * Claude Code one expands `${VAR}`, the Codex one forwards the same names via
 * `env_vars`. switchdash routes the values into the session's environment.
 *
 * Lives in `shared` so both halves of the remote path can reach it: the main
 * process bakes the launch recipe, and the on-VM sidecar (bundled free of
 * Electron and the database) spawns from it.
 */

import { NPM_TOKEN_VAR } from '@shared/core/npm-registry';

/** npm package name of the local Switch MCP runtime. */
export const SWITCH_AGENT_RUNTIME_PACKAGE = '@sandbox-quantum/switch-agent-runtime';

/**
 * Exact version the runtime is pinned to. Must match the pin in
 * `connectors/claude-code-plugin/.mcp.json`; `switch-agent-runtime.test.ts`
 * fails if the two drift. Bump both together when the runtime is republished.
 */
export const SWITCH_AGENT_RUNTIME_VERSION = '0.1.5';

/**
 * Credentials the runtime refuses to start without: it reads all three at
 * `bin.ts` module scope and exits before answering `initialize` if any is
 * missing, which a host reports only as a closed connection.
 *
 * This tier is the contract with the Claude Code connector, whose `.mcp.json`
 * declares the same three for `${VAR}` expansion.
 */
export const SWITCH_RUNTIME_REQUIRED_ENV = [
  'SWITCH_API_ENDPOINT',
  'SWITCH_API_TOKEN',
  'SWITCH_AGENT_ID',
] as const;

/**
 * Values the runtime uses when present and does without when absent — the
 * connection id and poll suppression it reads directly, plus the npm settings
 * `npx` needs to resolve the package from the private registry.
 *
 * Kept apart from the required tier because the two hosts cannot treat them
 * alike. Codex forwards names, so an unset one is simply not passed, and the
 * Codex connector's `.mcp.json` lists this tier under `env_vars`. Claude
 * expands `${VAR}`, which makes a declared variable mandatory — declaring
 * `SWITCH_CONNECTION_ID` there once cost every standalone session its tools.
 * This tier must therefore never be added to the *Claude* connector's
 * `.mcp.json`.
 */
export const SWITCH_RUNTIME_OPTIONAL_ENV = [
  'SWITCH_CONNECTION_ID',
  'SWITCH_CHANNEL_DISABLE_POLL',
  'npm_config_userconfig',
  NPM_TOKEN_VAR,
] as const;

/** Every variable a host must route to the runtime, required tier first. */
export const SWITCH_RUNTIME_ENV_VARS: readonly string[] = [
  ...SWITCH_RUNTIME_REQUIRED_ENV,
  ...SWITCH_RUNTIME_OPTIONAL_ENV,
];

/** stdio command that launches the runtime with `npx`, resolving the pinned version. */
export type SwitchAgentRuntimeCommand = {
  command: string;
  args: string[];
  /** Names the host must route into the server's process. See {@link SWITCH_RUNTIME_ENV_VARS}. */
  envVars: string[];
};

/**
 * The stdio command that runs the pinned Switch MCP runtime, and the names of
 * the variables it needs.
 *
 * A host does not hand its own environment to an MCP server it spawns. Codex
 * gives the child a fixed allowlist — `HOME`, `PATH`, `SHELL`, `USER`, `TMPDIR`
 * and a few more — and forwards nothing else unless the server's config names
 * it; Claude Code declares its own `env` block. So the command stays static and
 * secret-free, while `envVars` says what has to travel with it: without them
 * `npx` cannot reach the private registry and the runtime cannot authenticate.
 */
export function switchAgentRuntimeCommand(): SwitchAgentRuntimeCommand {
  return {
    command: 'npx',
    args: ['-y', `${SWITCH_AGENT_RUNTIME_PACKAGE}@${SWITCH_AGENT_RUNTIME_VERSION}`],
    envVars: [...SWITCH_RUNTIME_ENV_VARS],
  };
}
