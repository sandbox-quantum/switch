import path from 'node:path';

/**
 * Pure path constants/helpers for an agent's on-disk Switch settings. Kept in a
 * leaf module (only `node:path`) so the credentials reader — and through it the
 * remote sidecar bundle — can use them without pulling in the Electron-bound
 * agent-detection module.
 */

/**
 * Relative path, from an agent's working directory, to the Claude Code settings
 * file that the switch-connector `configure` skill writes the `SWITCH_*` env
 * block into for a per-location agent.
 */
export const SWITCH_SETTINGS_RELATIVE_PATH = path.join('.claude', 'settings.local.json');

/**
 * Directory, relative to an agent's working directory, where the switch-connector
 * `configure` skill writes per-subagent Switch credential files
 * (`<subagent_name>.settings.json`). switchdash discovers a parent agent's
 * launchable Claude Code subagents by scanning this directory.
 */
export const SWITCH_SUBAGENTS_DIR_RELATIVE = path.join('.claude', 'switch-subagents');

/** Absolute path to a subagent's Switch credentials file under `dir`. */
export function subagentSettingsPath(dir: string, subagentName: string): string {
  return path.join(dir, SWITCH_SUBAGENTS_DIR_RELATIVE, `${subagentName}.settings.json`);
}
