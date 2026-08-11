import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RECOGNISED_SWITCH_CONNECTOR_TOOL_RULES,
  SWITCH_CONNECTOR_TOOL_RULES,
} from '@switch-console/core/agents/plugins';
import type { PluginFs } from '@switch-console/core/agents/plugins';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import {
  agentSettingsRelativePath,
  SWITCH_AGENTS_GITIGNORE_RELATIVE,
  SWITCH_SETTINGS_RELATIVE_PATH,
} from './switch-settings-paths';

export interface SwitchSettingsCredentials {
  apiEndpoint: string;
  apiToken: string;
  agentId: string;
}

/**
 * Merge the `SWITCH_*` env block (and the connector tool-allow rules) into a
 * settings file, returning the new file text.
 *
 * The file is merged, not clobbered: unrelated top-level keys and any other
 * `env` entries the user already has are preserved. The connector MCP tools are
 * unioned into `permissions.allow` so they are auto-approved ("don't ask").
 *
 * **No token is written, and one already present is removed** (CHOO-1962). This
 * produces `.claude/settings.local.json`, which Claude Code reads natively and
 * which every session in the directory sees — it only needs to say who the agent
 * is. The credential lives in exactly one file, the per-agent
 * `.switch/agents/<slug>.json` that {@link mergeAgentCredentials} writes.
 *
 * Removing rather than merging forward matters: a merge would carry a token
 * written by an older Switch Console forward into a file that no longer needs one.
 *
 * Pure: takes the existing file text (or null when absent/unreadable) and
 * returns the text to write. Shared by the local writer and the remote (SFTP)
 * writer so on-disk and over-SSH setup produce byte-identical files.
 */
export function mergeSwitchSettings(
  existingRaw: string | null,
  creds: { apiEndpoint: string; agentId: string }
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

  const env: Record<string, unknown> = {
    ...currentEnv,
    SWITCH_API_ENDPOINT: creds.apiEndpoint,
    SWITCH_AGENT_ID: creds.agentId,
  };
  delete env.SWITCH_API_TOKEN;

  const merged = {
    ...existing,
    permissions: {
      ...currentPerms,
      allow: [...new Set([...currentAllow, ...SWITCH_CONNECTOR_TOOL_RULES])],
    },
    env,
  };

  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * The same merge for the provider-neutral per-agent file, which DOES carry the
 * token.
 *
 * The two files are not interchangeable. `.claude/settings.local.json` is
 * Claude Code's own, read by any session in the directory, and it only needs to
 * say who the agent is — the runtime resolves the rest. `.switch/agents/<slug>.json`
 * is the per-agent credential Switch Console injects at launch and the runtime falls
 * back to, so the token lives here, in exactly one place.
 */
export function mergeAgentCredentials(
  existingRaw: string | null,
  creds: SwitchSettingsCredentials
): string {
  const merged = JSON.parse(mergeSwitchSettings(existingRaw, creds)) as Record<string, unknown>;
  const env = { ...(merged.env as Record<string, unknown>), SWITCH_API_TOKEN: creds.apiToken };
  return `${JSON.stringify({ ...merged, env }, null, 2)}\n`;
}

/**
 * Update ONLY `SWITCH_API_ENDPOINT` in an already-provisioned settings file,
 * returning the new file text — or `null` when the file is not a provisioned
 * Switch agent (missing/unparseable, or its `env` names no endpoint and agent
 * id). Used to cascade a server's API-URL edit to its agents; the agent id,
 * permissions, and every other key are left byte-for-byte untouched.
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

  // Only a provisioned agent (endpoint + id present) is propagated to; anything
  // else is "not a Switch agent here" -> skip. A token is NOT required: since
  // CHOO-1962 a provisioned agent's token lives under `$HOME`, so demanding one
  // here would silently skip every agent the migration has already moved.
  if (
    !env ||
    typeof env.SWITCH_API_ENDPOINT !== 'string' ||
    typeof env.SWITCH_AGENT_ID !== 'string'
  ) {
    return null;
  }

  const merged = { ...existing, env: { ...env, SWITCH_API_ENDPOINT: apiEndpoint } };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

/**
 * Reverse of {@link mergeSwitchSettings}: strip the `SWITCH_*` env block and the
 * connector tool-allow rules that provisioning added, returning what to do with
 * the file. Every other key — user env entries, other `permissions.allow` rules,
 * `hooks`, and any unrelated top-level keys — is preserved byte-for-byte.
 *
 * The result is a small command rather than a bare string so the caller can tell
 * "nothing of ours here, leave it" (`skip`) from "our keys were the only thing in
 * the file, remove it" (`delete`) from "rewrite with our keys gone" (`write`):
 * - `skip`   — file absent/unparseable, or it carries no `SWITCH_*` credentials
 *              (not a provisioned agent) — do not touch it.
 * - `delete` — after removing our keys the object is empty `{}` — the file was
 *              ours alone, so remove it rather than leaving an empty husk.
 * - `write`  — the cleaned file text, with our keys gone and everything else kept.
 *
 * Pure: takes the existing file text (or null when absent/unreadable) and returns
 * the command. Shared by the local and remote (SFTP) teardown paths so both
 * produce byte-identical results.
 */
export type RemoveSwitchSettingsResult =
  | { kind: 'skip' }
  | { kind: 'write'; content: string }
  | { kind: 'delete' };

export function removeSwitchSettings(existingRaw: string | null): RemoveSwitchSettingsResult {
  if (existingRaw === null) return { kind: 'skip' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(existingRaw);
  } catch {
    return { kind: 'skip' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'skip' };

  const existing = parsed as Record<string, unknown>;
  const env =
    existing.env && typeof existing.env === 'object' && !Array.isArray(existing.env)
      ? { ...(existing.env as Record<string, unknown>) }
      : null;

  // No `SWITCH_*` credentials -> this is not a provisioned Switch agent; leave the
  // file exactly as it is rather than rewriting someone else's config.
  const hasSwitchCreds =
    env !== null &&
    ('SWITCH_API_ENDPOINT' in env || 'SWITCH_API_TOKEN' in env || 'SWITCH_AGENT_ID' in env);
  if (!hasSwitchCreds) return { kind: 'skip' };

  const result: Record<string, unknown> = { ...existing };

  delete env.SWITCH_API_ENDPOINT;
  delete env.SWITCH_API_TOKEN;
  delete env.SWITCH_AGENT_ID;
  if (Object.keys(env).length > 0) {
    result.env = env;
  } else {
    delete result.env;
  }

  const perms =
    existing.permissions &&
    typeof existing.permissions === 'object' &&
    !Array.isArray(existing.permissions)
      ? { ...(existing.permissions as Record<string, unknown>) }
      : null;
  if (perms && Array.isArray(perms.allow)) {
    const allow = (perms.allow as unknown[])
      .map(String)
      .filter((rule) => !RECOGNISED_SWITCH_CONNECTOR_TOOL_RULES.includes(rule));
    if (allow.length > 0) {
      perms.allow = allow;
    } else {
      delete perms.allow;
    }
    if (Object.keys(perms).length > 0) {
      result.permissions = perms;
    } else {
      delete result.permissions;
    }
  }

  if (Object.keys(result).length === 0) return { kind: 'delete' };
  return { kind: 'write', content: `${JSON.stringify(result, null, 2)}\n` };
}

/**
 * Write the `SWITCH_*` env block into a local directory's
 * `.claude/settings.local.json`, the same file the switch-connector
 * `configure` skill writes.
 *
 * No token: it lives in the per-agent `.switch/agents/<slug>.json` alone. Claude
 * Code reads this file natively, so the endpoint and agent id being here is what
 * lets a session started by hand know which agent it is.
 */
export async function writeSwitchSettings(params: {
  dir: string;
  apiEndpoint: string;
  agentId: string;
}): Promise<void> {
  const settingsPath = path.join(params.dir, SWITCH_SETTINGS_RELATIVE_PATH);

  let existingRaw: string | null = null;
  try {
    existingRaw = await fs.readFile(settingsPath, 'utf8');
  } catch (error) {
    // Start fresh only when the file is genuinely absent. Any other read
    // failure must propagate — merging into "nothing" would rewrite the file
    // without its hooks block.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      throw error;
    }
  }

  const merged = mergeSwitchSettings(existingRaw, params);
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, merged, 'utf8');
}

/**
 * Write an agent's Switch credentials to its provider-neutral per-agent file
 * `.switch/agents/<slug>.json` (CHOO-1440), alongside the connector-owned
 * `.claude/settings.local.json`. Switch Console injects this file's env at launch, so
 * it is the authoritative per-agent identity — letting multiple agents share a
 * location without colliding on the single `settings.local.json` identity.
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
 * (the agent name) — the authoritative identity Switch Console injects at launch
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
  const merged = mergeAgentCredentials(await workspaceFs.read(relPath), params);
  await workspaceFs.write(relPath, merged);
}
