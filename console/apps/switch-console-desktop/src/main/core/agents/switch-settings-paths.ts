import path from 'node:path';

/**
 * Pure path constants/helpers for an agent's on-disk Switch settings. Kept in a
 * leaf module (only `node:path`) so the credentials reader — and through it the
 * remote sidecar bundle — can use them without pulling in the Electron-bound
 * agent-detection module.
 *
 * Every *relative* path here is a forward-slash literal, never `path.join`: these
 * are handed to a `PluginFs`, which is either the local disk or a remote POSIX
 * host over SFTP, and `path.join` emits backslashes when Switch Console runs on
 * Windows. The *absolute* helpers below still use `path.join`, which normalises a
 * forward-slash tail correctly on every platform.
 */

/**
 * Relative path, from an agent's working directory, to the Claude Code settings
 * file that the switch-connector `configure` skill writes the `SWITCH_*` env
 * block into for a per-location agent.
 */
export const SWITCH_SETTINGS_RELATIVE_PATH = '.claude/settings.local.json';

/**
 * Directory, relative to an agent's working directory, where the switch-connector
 * `configure` skill writes per-subagent Switch credential files
 * (`<subagent_name>.settings.json`). Switch Console discovers a parent agent's
 * launchable Claude Code subagents by scanning this directory.
 */
export const SWITCH_SUBAGENTS_DIR_RELATIVE = '.claude/switch-subagents';

/** Absolute path to a subagent's Switch credentials file under `dir`. */
export function subagentSettingsPath(dir: string, agentName: string): string {
  return path.join(dir, SWITCH_SUBAGENTS_DIR_RELATIVE, `${agentName}.settings.json`);
}

/**
 * Provider-neutral directory, relative to a location's working directory, where
 * Switch Console writes one Switch credentials file per agent (`<slug>.json`). This
 * replaces the two Claude-specific layouts — the shared `.claude/settings.local.json`
 * for a "main" agent and `.claude/switch-subagents/<name>.settings.json` for a
 * subagent — with a single per-agent format that works for every provider
 * (CHOO-1440). The `.claude/agents/<name>.md` *definition* stays under `.claude`
 * because it is Claude-specific; only the Switch credentials move here.
 */
export const SWITCH_AGENTS_DIR_RELATIVE = '.switch/agents';

/**
 * Relative path to the `.gitignore` that keeps the per-agent credentials files
 * (which contain `SWITCH_API_TOKEN`) out of version control. Its content is `*`
 * so the whole directory is ignored.
 */
export const SWITCH_AGENTS_GITIGNORE_RELATIVE = `${SWITCH_AGENTS_DIR_RELATIVE}/.gitignore`;

/**
 * Relative path (from a location dir) to an agent's provider-neutral Switch
 * credentials file. `slug` is a filesystem-safe per-agent key — the agent's
 * definition name for a subagent-derived agent, or its stable name otherwise.
 */
export function agentSettingsRelativePath(slug: string): string {
  return `${SWITCH_AGENTS_DIR_RELATIVE}/${slug}.json`;
}

/** Absolute path to an agent's provider-neutral Switch credentials file under `dir`. */
export function agentSettingsPath(dir: string, slug: string): string {
  return path.join(dir, agentSettingsRelativePath(slug));
}
