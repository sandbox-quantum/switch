import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import type { AgentSecretStore } from '@main/core/agents/switch-agent-secrets';
import {
  agentSettingsRelativePath,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from '@main/core/agents/switch-settings-paths';

export interface SwitchAgentCredentials {
  agentId: string;
  apiEndpoint: string;
  token: string;
}

/** {@link SwitchAgentCredentials} before the home-side token has been paired in. */
export interface SwitchAgentIdentity {
  agentId: string;
  apiEndpoint: string;
  token: string | null;
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
  const identity = parseSwitchAgentIdentity(await workspaceFs.read(relPath), log);
  if (!identity) {
    log.warn(
      'readAgentSwitchEnvFromFs: no Switch identity for agent; session will not authenticate as it',
      { slug, path: relPath }
    );
    return {};
  }
  return {
    SWITCH_API_ENDPOINT: identity.apiEndpoint,
    SWITCH_AGENT_ID: identity.agentId,
    ...(identity.token ? { SWITCH_API_TOKEN: identity.token } : {}),
  };
}

/**
 * Pair a launch env with the token from the home-side store, when the file it
 * came from no longer carries one.
 *
 * Applied at the launch sites rather than inside each reader because the two
 * paths that produce this env — the neutral file and a Claude subagent's
 * definition credentials — live in different packages, and only one of them can
 * see the secret store. Doing it once at the join keeps them from drifting.
 *
 * An env that already has a token is returned untouched, so a session launched
 * before the migration reaches that agent still works.
 */
export async function withAgentSecret(
  env: Record<string, string>,
  secrets: AgentSecretStore,
  log: CredentialsLogger
): Promise<Record<string, string>> {
  if (env.SWITCH_API_TOKEN || !env.SWITCH_AGENT_ID) return env;

  const token = await secrets.read(env.SWITCH_AGENT_ID);
  if (!token) {
    log.warn('withAgentSecret: no stored secret for agent; session cannot authenticate as it', {
      agentId: env.SWITCH_AGENT_ID,
    });
    return env;
  }
  return { ...env, SWITCH_API_TOKEN: token };
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
  const identity = parseSwitchAgentIdentity(raw, log);
  if (!identity || !identity.token) return null;
  return { agentId: identity.agentId, apiEndpoint: identity.apiEndpoint, token: identity.token };
}

/**
 * Who a settings file says the agent is, with the token only if it happens to be
 * there.
 *
 * The provider-neutral `.switch/agents/<slug>.json` no longer carries a token —
 * it moved to `$HOME` at `0600` (CHOO-1962) — so a reader that demands one, as
 * {@link parseSwitchAgentCredentials} does, reads a perfectly good file as
 * unconfigured. Callers that can reach the home store use this and pair it with
 * a lookup; callers reading `.claude/settings.local.json`, which still holds its
 * own token, keep using the stricter one.
 *
 * A token that IS present is returned, so a file written before the split still
 * resolves without waiting for the migration to reach it.
 */
export function parseSwitchAgentIdentity(
  raw: string | null,
  log: CredentialsLogger
): SwitchAgentIdentity | null {
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
  if (!agentId || !apiEndpoint) return null;

  return { agentId, apiEndpoint, token: asNonEmptyString(env.SWITCH_API_TOKEN) };
}

/**
 * Resolve one agent's full credentials from the two halves: the identity in its
 * working tree, the token under `$HOME`.
 *
 * Returns null when either half is missing — an agent whose secret has been
 * revoked or never written cannot authenticate, and saying so here keeps every
 * caller from having to spot a half-populated result.
 */
export async function resolveAgentCredentials(
  workspaceFs: PluginFs,
  secrets: AgentSecretStore,
  slug: string,
  log: CredentialsLogger
): Promise<SwitchAgentCredentials | null> {
  const identity = parseSwitchAgentIdentity(
    await workspaceFs.read(agentSettingsRelativePath(slug)),
    log
  );
  if (!identity) return null;

  const token = identity.token ?? (await secrets.read(identity.agentId));
  if (!token) return null;

  return { agentId: identity.agentId, apiEndpoint: identity.apiEndpoint, token };
}
