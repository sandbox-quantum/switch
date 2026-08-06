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
 * The credentials switchdash injects into a session it launches. The runtime
 * takes all three together as its identity and asks no further questions —
 * this is the first branch of its resolution chain, and the one the majority
 * of sessions take.
 *
 * Since CHOO-1962 they are no longer *required*: a session nobody configured
 * this way falls back to the on-disk agent store rather than exiting. What
 * follows from that is that the Claude connector's `.mcp.json` declares **no
 * `env` block at all** — a `${VAR}` there is mandatory once declared, so
 * declaring these would break exactly the standalone case the fallback exists
 * for. Codex still lists them under `env_vars`, which forwards by name and
 * skips whatever is unset.
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

/**
 * The stdio command that runs the pinned runtime is no longer built here: both
 * connector plugins declare it in their own bundled `.mcp.json`. What switchdash
 * still owns is putting the values behind {@link SWITCH_RUNTIME_ENV_VARS} into
 * the session's environment — a host does not hand an MCP server a copy of its
 * own environment, so Codex forwards only the names its config lists and Claude
 * only what its `env` block expands. `switch-agent-runtime.test.ts` holds both
 * plugin files to the constants above so a rename cannot land on one side only.
 */
