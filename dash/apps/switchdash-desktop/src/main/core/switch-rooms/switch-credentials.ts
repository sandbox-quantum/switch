import { promises as fs } from 'node:fs';
import path from 'node:path';
import { SWITCH_SETTINGS_RELATIVE_PATH } from '@main/core/agents/switch-settings-paths';

export interface SwitchAgentCredentials {
  agentId: string;
  apiEndpoint: string;
  token: string;
}

/**
 * Minimal logger the credential reader needs. Injected rather than imported so
 * the reader can run in the remote sidecar bundle, which must not pull in the
 * Electron-bound main-process file logger.
 */
export interface CredentialsLogger {
  warn(...input: unknown[]): void;
}

interface ClaudeSettingsEnv {
  SWITCH_API_ENDPOINT?: unknown;
  SWITCH_AGENT_ID?: unknown;
  SWITCH_API_TOKEN?: unknown;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Read the full Switch agent credentials (including the API token) from an
 * agent directory's `.claude/settings.local.json` env block.
 *
 * Unlike {@link detectSwitchAgent}, this reads `SWITCH_API_TOKEN` — it is used
 * only by the notification poller, which must authenticate to the agent bridge
 * on the agent's behalf. Returns null when the file is missing/unparseable or
 * any of the three values is absent.
 */
export async function readSwitchAgentCredentials(
  dir: string,
  log: CredentialsLogger
): Promise<SwitchAgentCredentials | null> {
  return readSwitchAgentCredentialsFromSettings(path.join(dir, SWITCH_SETTINGS_RELATIVE_PATH), log);
}

/**
 * Read Switch agent credentials from a specific settings file. Used to poll as a
 * subagent (its `.claude/switch-subagents/<name>.settings.json`) rather than the
 * parent's `.claude/settings.local.json`, so the session receives the events
 * addressed to the subagent — not the parent.
 */
export async function readSwitchAgentCredentialsFromSettings(
  settingsPath: string,
  log: CredentialsLogger
): Promise<SwitchAgentCredentials | null> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath, 'utf8');
  } catch {
    return null;
  }
  return parseSwitchAgentCredentials(raw, log);
}

/**
 * Read an agent's Switch credentials from a settings file and return them as the
 * `SWITCH_*` env vars a launched session needs, or `{}` when the file is
 * missing/incomplete. Used to inject an agent's identity at launch from its
 * provider-neutral `.switch/agents/<id>.json` (CHOO-1440).
 */
export async function readAgentSwitchEnv(
  settingsPath: string,
  log: CredentialsLogger
): Promise<Record<string, string>> {
  const creds = await readSwitchAgentCredentialsFromSettings(settingsPath, log);
  if (!creds) return {};
  return {
    SWITCH_API_ENDPOINT: creds.apiEndpoint,
    SWITCH_API_TOKEN: creds.token,
    SWITCH_AGENT_ID: creds.agentId,
  };
}

/**
 * Parse Switch agent credentials from the raw text of a `.claude/settings.local.json`.
 * Transport-agnostic (no filesystem): used by both the local readers above and
 * the remote preflight, which fetches the file over SFTP. Returns null when the
 * text is unparseable or any of the three values is absent.
 */
export function parseSwitchAgentCredentials(
  raw: string,
  log: CredentialsLogger
): SwitchAgentCredentials | null {
  let env: ClaudeSettingsEnv | undefined;
  try {
    env = (JSON.parse(raw) as { env?: ClaudeSettingsEnv })?.env;
  } catch (error) {
    log.warn('switch-rooms: failed to parse Claude settings file for credentials', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }

  if (!env) return null;

  const agentId = asNonEmptyString(env.SWITCH_AGENT_ID);
  const apiEndpoint = asNonEmptyString(env.SWITCH_API_ENDPOINT);
  const token = asNonEmptyString(env.SWITCH_API_TOKEN);
  if (!agentId || !apiEndpoint || !token) return null;

  return { agentId, apiEndpoint, token };
}
