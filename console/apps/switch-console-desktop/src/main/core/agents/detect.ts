import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '@main/lib/logger';
import type { SwitchAgentConfig } from '@shared/switch-agents';
import { SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';

interface ClaudeSettingsEnv {
  SWITCH_API_ENDPOINT?: unknown;
  SWITCH_AGENT_ID?: unknown;
  // SWITCH_API_TOKEN is present in the file but deliberately never read here.
}

interface ClaudeSettingsFile {
  env?: ClaudeSettingsEnv;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Parse the raw contents of a Claude Code `settings.local.json` and extract the
 * Switch agent identity from its `SWITCH_*` env block. Pure: works for both
 * local (read from disk) and remote (read over SSH) sources.
 *
 * Returns `null` when the file is unparseable or lacks a usable
 * `SWITCH_AGENT_ID` / `SWITCH_API_ENDPOINT`. Only a malformed file is logged.
 */
export function parseSwitchAgentSettings(raw: string, dir: string): SwitchAgentConfig | null {
  let env: ClaudeSettingsEnv | undefined;
  try {
    env = (JSON.parse(raw) as ClaudeSettingsFile)?.env;
  } catch (error) {
    log.warn('switch-agents: failed to parse Claude settings file', {
      dir,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!env) return null;

  const agentId = asNonEmptyString(env.SWITCH_AGENT_ID);
  const apiEndpoint = asNonEmptyString(env.SWITCH_API_ENDPOINT);
  if (!agentId || !apiEndpoint) return null;

  return { agentId, apiEndpoint, dir };
}

/**
 * Detect whether `dir` is configured as a Switch agent by reading its
 * `.claude/settings.local.json` and extracting the `SWITCH_*` env block.
 *
 * Returns `null` when the directory has no settings file, the file is
 * unparseable, or it lacks a usable `SWITCH_AGENT_ID` / `SWITCH_API_ENDPOINT`.
 * Missing/unreadable files are normal (most directories are not agents) and are
 * not logged; only a malformed settings file is surfaced as a warning.
 */
export async function detectSwitchAgent(dir: string): Promise<SwitchAgentConfig | null> {
  const settingsPath = path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return null;
  }

  return parseSwitchAgentSettings(raw, dir);
}
