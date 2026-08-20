import { promises as fs } from 'node:fs';
import path from 'node:path';
import { log } from '@main/lib/logger';
import type { SwitchAgentConfig } from '@shared/switch-agents';
import { SWITCH_AGENTS_DIR_RELATIVE, SWITCH_SETTINGS_RELATIVE_PATH } from './switch-settings-paths';

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
 * The identity in a credentials file, without its token.
 *
 * `SWITCH_API_TOKEN` is in the file and is deliberately not read: recognising a
 * directory needs no secret, and keeping it unread is what makes detection a
 * non-destructive, credential-free operation.
 */
async function readStoreIdentity(dir: string): Promise<SwitchAgentConfig | null> {
  const storeDir = path.join(dir, SWITCH_AGENTS_DIR_RELATIVE);

  let entries: string[];
  try {
    entries = (await fs.readdir(storeDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return null;
  }

  const found: SwitchAgentConfig[] = [];
  for (const entry of entries) {
    let raw: string;
    try {
      raw = await fs.readFile(path.join(storeDir, entry), 'utf8');
    } catch {
      continue;
    }
    let env: Record<string, unknown> | undefined;
    try {
      env = (JSON.parse(raw) as { env?: Record<string, unknown> })?.env;
    } catch {
      log.warn('switch-agents: unparseable credentials file', { dir, entry });
      continue;
    }
    const agentId = asNonEmptyString(env?.SWITCH_AGENT_ID);
    const apiEndpoint = asNonEmptyString(env?.SWITCH_API_ENDPOINT);
    if (agentId && apiEndpoint) found.push({ agentId, apiEndpoint, dir });
  }

  // Several agents in one directory is a supported setup — the session picks one
  // with `select_agent`. Nothing here can make that choice, so report no single
  // identity rather than guessing which one the directory "is".
  return found.length === 1 ? found[0] : null;
}

/**
 * Detect whether `dir` is configured as a Switch agent.
 *
 * Two layouts count, because two things configure a directory. Switch Console
 * writes the identity into `.claude/settings.local.json`; the connector's
 * `configure` skill deliberately writes no `SWITCH_*` there at all and leaves
 * only the credentials store, since a half-set environment is what breaks a
 * standalone session. Reading the settings file alone would make every
 * skill-configured directory invisible here.
 *
 * The settings file wins when both exist: it is what Claude Code exports into
 * the session, so it is what that directory actually resolves as.
 *
 * Returns `null` when neither names a usable `SWITCH_AGENT_ID` /
 * `SWITCH_API_ENDPOINT`, or when the store holds several agents and no single
 * identity can be named. Missing files are normal and are not logged; only a
 * malformed one is surfaced as a warning.
 */
export async function detectSwitchAgent(dir: string): Promise<SwitchAgentConfig | null> {
  const settingsPath = path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH);

  let raw: string | null = null;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    raw = null;
  }

  const fromSettings = raw === null ? null : parseSwitchAgentSettings(raw, dir);
  return fromSettings ?? (await readStoreIdentity(dir));
}
