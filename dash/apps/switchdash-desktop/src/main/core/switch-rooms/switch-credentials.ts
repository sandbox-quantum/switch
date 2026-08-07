import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import {
  agentSettingsRelativePath,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from '@main/core/agents/switch-settings-paths';

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

/** The `SWITCH_*` env vars a launched session needs to act as the agent. */
function credentialsAsEnv(creds: SwitchAgentCredentials | null): Record<string, string> {
  if (!creds) return {};
  return {
    SWITCH_API_ENDPOINT: creds.apiEndpoint,
    SWITCH_API_TOKEN: creds.token,
    SWITCH_AGENT_ID: creds.agentId,
  };
}

/**
 * Read an agent's Switch credentials from a settings file and return them as the
 * `SWITCH_*` env vars a launched session needs, or `{}` when the file is
 * missing/incomplete. Used to inject an agent's identity at launch from its
 * provider-neutral `.switch/agents/<name>.json` (CHOO-1440).
 */
export async function readAgentSwitchEnv(
  settingsPath: string,
  log: CredentialsLogger
): Promise<Record<string, string>> {
  return credentialsAsEnv(await readSwitchAgentCredentialsFromSettings(settingsPath, log));
}

/**
 * The {@link readAgentSwitchEnv} equivalent over a {@link PluginFs} rooted at the
 * agent's working directory, so the local and remote (SFTP) launch paths inject
 * the same identity from the same `.switch/agents/<slug>.json`.
 *
 * An empty result is a degraded launch, not a neutral one: the session starts
 * without a Switch identity, and only Claude recovers by reading
 * `.claude/settings.local.json` natively. Every other provider silently is not
 * the agent, so the miss is warned about here rather than at each call site.
 */
export async function readAgentSwitchEnvFromFs(
  workspaceFs: PluginFs,
  slug: string,
  log: CredentialsLogger
): Promise<Record<string, string>> {
  const relPath = agentSettingsRelativePath(slug);
  const env = credentialsAsEnv(parseSwitchAgentCredentials(await workspaceFs.read(relPath), log));
  if (Object.keys(env).length === 0) {
    log.warn(
      'readAgentSwitchEnvFromFs: no Switch identity for agent; session will not authenticate as it',
      { slug, path: relPath }
    );
  }
  return env;
}

/**
 * Parse Switch agent credentials from the raw text of a settings file, or `null`
 * for an absent one. Transport-agnostic (no filesystem): used by both the local
 * readers above and the remote preflight, which fetches the file over SFTP.
 * Returns null when the file is absent, the text is unparseable, or any of the
 * three values is missing — but only warns for text it could not parse, since an
 * absent file is an ordinary "this agent isn't provisioned here" answer.
 */
export function parseSwitchAgentCredentials(
  raw: string | null,
  log: CredentialsLogger
): SwitchAgentCredentials | null {
  if (raw === null) return null;

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
