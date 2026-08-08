import { SWITCH_CONNECTOR_TOOL_RULES } from '@switchdash/core/agents/plugins';
import type { PluginFs } from '@switchdash/core/agents/plugins';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
} from './switch-settings-paths';

export interface SwitchSettingsCredentials {
  apiEndpoint: string;
  apiToken: string;
  agentId: string;
}

/**
 * Merge the `SWITCH_*` env block (and the connector tool-allow rules) into a
 * Claude-settings-shaped credentials file, returning the new file text.
 *
 * The file is merged, not clobbered: any unrelated top-level keys and any other
 * `env` entries the user already has are preserved, and only the three
 * `SWITCH_*` keys are set/overwritten. The connector MCP tools are unioned into
 * `permissions.allow` so they are auto-approved ("don't ask").
 *
 * Pure: takes the existing file text (or null when absent/unreadable) and
 * returns the text to write, so a local write and one over SFTP produce
 * byte-identical files.
 */
export function mergeSwitchSettings(
  existingRaw: string | null,
  creds: SwitchSettingsCredentials
): string {
  let existing: Record<string, unknown> = {};
  if (existingRaw !== null) {
    try {
      const parsed: unknown = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Unparseable file: start fresh. A malformed file is rare and would be
      // replaced wholesale rather than half-merged.
    }
  }

  const currentEnv =
    existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
      ? (existing.env as Record<string, unknown>)
      : {};

  const currentPerms =
    existing.permissions &&
    typeof existing.permissions === 'object' &&
    !Array.isArray(existing.permissions)
      ? (existing.permissions as Record<string, unknown>)
      : {};
  const currentAllow = Array.isArray(currentPerms.allow)
    ? (currentPerms.allow as unknown[]).map(String)
    : [];

  const merged = {
    ...existing,
    permissions: {
      ...currentPerms,
      allow: [...new Set([...currentAllow, ...SWITCH_CONNECTOR_TOOL_RULES])],
    },
    env: {
      ...currentEnv,
      SWITCH_API_ENDPOINT: creds.apiEndpoint,
      SWITCH_API_TOKEN: creds.apiToken,
      SWITCH_AGENT_ID: creds.agentId,
    },
  };

  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Update ONLY `SWITCH_API_ENDPOINT` in an already-provisioned settings file,
 * returning the new file text — or `null` when the file is not a provisioned
 * Switch agent (missing/unparseable, or its `env` lacks the full `SWITCH_*`
 * credential block). Used to cascade a server's API-URL edit to its agents
 * without ever reading or rewriting the agent's `SWITCH_API_TOKEN`: the token,
 * agent id, permissions, and every other key are left byte-for-byte untouched.
 *
 * Returning `null` (rather than writing) for an unprovisioned file is deliberate
 * — the caller skips it instead of creating a token-less config that would look
 * configured but can't authenticate.
 *
 * Pure: takes the existing file text (or null when absent/unreadable) and
 * returns the text to write. Shared by the local and remote (SFTP) propagation
 * paths so both produce byte-identical files.
 */
export function mergeSwitchApiEndpoint(
  existingRaw: string | null,
  apiEndpoint: string
): string | null {
  if (existingRaw === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingRaw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const existing = parsed as Record<string, unknown>;
  const env =
    existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
      ? (existing.env as Record<string, unknown>)
      : null;

  // Only a fully provisioned agent (endpoint + token + id all present) is
  // propagated to; anything else is "not a Switch agent here" -> skip.
  if (
    !env ||
    typeof env.SWITCH_API_ENDPOINT !== 'string' ||
    typeof env.SWITCH_API_TOKEN !== 'string' ||
    typeof env.SWITCH_AGENT_ID !== 'string'
  ) {
    return null;
  }

  const merged = { ...existing, env: { ...env, SWITCH_API_ENDPOINT: apiEndpoint } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Write an agent's Switch credentials to its provider-neutral per-agent file
 * `.switch/agents/<slug>.json` (CHOO-1440). switchdash injects this file's env
 * at launch, so it is the authoritative per-agent identity — letting any number
 * of agents share a working directory without colliding.
 *
 * `apiToken` is the agent's secret API key — written here and never returned to
 * the renderer or logged. A `.gitignore` keeps the directory out of version
 * control.
 */
export async function writeAgentNeutralSettings(
  params: { dir: string; slug: string } & SwitchSettingsCredentials
): Promise<void> {
  await writeNeutralAgentSettingsFs(createPluginFs(params.dir), params);
}

/**
 * Write an agent's provider-neutral per-agent Switch credentials over a
 * {@link PluginFs} (local disk or a remote repo dir via SFTP), keyed by `slug`
 * (the agent name) — the authoritative identity switchdash injects at launch
 * (`agentSettingsPath`). This is the single per-agent credential writer for every
 * provider and every transport; providers with repo-agent definitions (Claude)
 * layer their definition on top.
 *
 * The `.gitignore` is written first: it is what keeps `SWITCH_API_TOKEN` out of
 * version control, so it must already be in place before the token reaches disk.
 */
export async function writeNeutralAgentSettingsFs(
  workspaceFs: PluginFs,
  params: { slug: string } & SwitchSettingsCredentials
): Promise<void> {
  if (!(await workspaceFs.exists(SWITCH_AGENTS_GITIGNORE_RELATIVE))) {
    await workspaceFs.write(SWITCH_AGENTS_GITIGNORE_RELATIVE, '*\n');
  }
  const relPath = agentSettingsRelativePath(params.slug);
  const merged = mergeSwitchSettings(await workspaceFs.read(relPath), params);
  await workspaceFs.write(relPath, merged);
}
