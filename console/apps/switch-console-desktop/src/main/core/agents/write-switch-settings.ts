import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  RECOGNISED_SWITCH_CONNECTOR_TOOL_RULES,
  SWITCH_CONNECTOR_TOOL_RULES,
} from '@switch-console/core/agents/plugins';
import type { PluginFs } from '@switch-console/core/agents/plugins';
import { createPluginFs } from '@main/core/providers/plugin-fs';
import { sameApiEndpoint } from '@shared/core/switch-servers/switch-servers';
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
 * The Switch deployment an existing per-agent credentials file belongs to, when
 * that is a DIFFERENT deployment from the one about to be written — otherwise
 * null (no file, not a provisioned agent, or the same deployment).
 *
 * The endpoint is the discriminator because the gateway's name check is global
 * per deployment: two Switch Console installs can only mint the same agent name
 * when they point at different servers, and every credentials file already
 * carries its endpoint. Same server, same name is this install rewriting its own
 * agent (or replacing one deleted on the server) and is left alone.
 *
 * Compared with {@link sameApiEndpoint}, the same match the import path uses to
 * decide which server a discovered agent belongs to — the two have to agree, or
 * an agent that cannot be imported here could still be overwritten here.
 *
 * Pure: takes the existing file text (or null when absent/unreadable).
 */
export function foreignCredentialsEndpoint(
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

  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;

  const existingEndpoint = (env as Record<string, unknown>).SWITCH_API_ENDPOINT;
  if (typeof existingEndpoint !== 'string' || existingEndpoint.trim() === '') return null;

  return sameApiEndpoint(existingEndpoint, apiEndpoint) ? null : existingEndpoint;
}

/**
 * The credentials file for this agent name is already another Switch
 * deployment's. Writing would merge this install's identity over it, leaving one
 * file that carries the new identity and the old file's other keys — so the
 * displaced agent's sessions authenticate as this one instead of failing, and
 * its API token, minted once, is gone.
 */
export class ForeignAgentCredentialsError extends Error {
  readonly slug: string;
  readonly relPath: string;
  readonly existingEndpoint: string;
  readonly incomingEndpoint: string;

  constructor(params: {
    slug: string;
    relPath: string;
    existingEndpoint: string;
    incomingEndpoint: string;
  }) {
    super(
      `${params.relPath} in this directory belongs to the Switch server at ${params.existingEndpoint}, but this agent is on ${params.incomingEndpoint}. Writing it would overwrite that agent's identity and destroy its API token, which cannot be recovered. Use a different agent name, or a different working directory.`
    );
    this.name = 'ForeignAgentCredentialsError';
    this.slug = params.slug;
    this.relPath = params.relPath;
    this.existingEndpoint = params.existingEndpoint;
    this.incomingEndpoint = params.incomingEndpoint;
  }
}

/**
 * The credentials file for this agent name already belongs to a different
 * agent on the SAME Switch deployment. Writing would overwrite that agent's
 * identity and destroy its API token — the same hazard as
 * {@link ForeignAgentCredentialsError}, but between agents on the same server
 * rather than across deployments (CHOO-2560).
 */
export class ExistingAgentCredentialsError extends Error {
  readonly slug: string;
  readonly relPath: string;
  readonly existingAgentId: string;
  readonly incomingAgentId: string;

  constructor(params: {
    slug: string;
    relPath: string;
    existingAgentId: string;
    incomingAgentId: string;
  }) {
    super(
      `${params.relPath} in this directory already holds credentials for agent ${params.existingAgentId} on this Switch server. Writing it would overwrite that agent's identity and destroy its API token, which cannot be recovered. Load the existing agent instead, or use a different agent name.`
    );
    this.name = 'ExistingAgentCredentialsError';
    this.slug = params.slug;
    this.relPath = params.relPath;
    this.existingAgentId = params.existingAgentId;
    this.incomingAgentId = params.incomingAgentId;
  }
}

/**
 * Read the per-agent credentials slot for `slug` and report the Switch
 * deployment it already belongs to, when that is a different one. Callers use
 * this BEFORE minting an identity, so a collision is refused without leaving an
 * orphaned agent (and an unrecoverable token) behind on the server; the writer
 * below re-checks, so a path that skips this one still cannot clobber.
 */
export async function foreignCredentialsOwnerFs(
  workspaceFs: PluginFs,
  slug: string,
  apiEndpoint: string
): Promise<string | null> {
  const existingRaw = await workspaceFs.read(agentSettingsRelativePath(slug));
  return foreignCredentialsEndpoint(existingRaw, apiEndpoint);
}

/**
 * The `SWITCH_AGENT_ID` already in a credentials slot when the file belongs to
 * the SAME deployment — otherwise null (no file, not a provisioned agent, or a
 * different deployment).
 *
 * This is the inverse of {@link foreignCredentialsEndpoint}: that one catches
 * a different-server collision; this one catches a same-server collision where
 * the identity exists on-disk but is unknown to this install's database — i.e.
 * a colleague's agent that would be clobbered by a blind write.
 *
 * Pure: takes the existing file text (or null when absent/unreadable).
 */
export function existingAgentIdInSlot(
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

  const env = (parsed as Record<string, unknown>).env;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return null;

  const existingEndpoint = (env as Record<string, unknown>).SWITCH_API_ENDPOINT;
  if (typeof existingEndpoint !== 'string' || existingEndpoint.trim() === '') return null;

  if (!sameApiEndpoint(existingEndpoint, apiEndpoint)) return null;

  const agentId = (env as Record<string, unknown>).SWITCH_AGENT_ID;
  if (typeof agentId !== 'string' || agentId.trim() === '') return null;

  return agentId;
}

/**
 * Write an agent's provider-neutral per-agent Switch credentials over a
 * {@link PluginFs} (local disk or a remote repo dir via SFTP), keyed by `slug`
 * (the agent name) — the authoritative identity Switch Console injects at launch
 * (`agentSettingsPath`). This is the single per-agent credential writer for every
 * provider and every transport; providers with repo-agent definitions (Claude)
 * layer their definition on top.
 *
 * Being the single writer is what makes it the place to refuse a slot that is
 * another deployment's: every create path funnels through here, so none of them
 * can overwrite one (CHOO-1960). It throws {@link ForeignAgentCredentialsError}
 * rather than writing.
 *
 * The `.gitignore` is written before the credentials: it is what keeps
 * `SWITCH_API_TOKEN` out of version control, so it must already be in place
 * before the token reaches disk.
 */
export async function writeNeutralAgentSettingsFs(
  workspaceFs: PluginFs,
  params: { slug: string } & SwitchSettingsCredentials
): Promise<void> {
  const relPath = agentSettingsRelativePath(params.slug);
  const existingRaw = await workspaceFs.read(relPath);
  const existingEndpoint = foreignCredentialsEndpoint(existingRaw, params.apiEndpoint);
  if (existingEndpoint !== null) {
    throw new ForeignAgentCredentialsError({
      slug: params.slug,
      relPath,
      existingEndpoint,
      incomingEndpoint: params.apiEndpoint,
    });
  }

  if (!(await workspaceFs.exists(SWITCH_AGENTS_GITIGNORE_RELATIVE))) {
    await workspaceFs.write(SWITCH_AGENTS_GITIGNORE_RELATIVE, '*\n');
  }
  await workspaceFs.write(relPath, mergeAgentCredentials(existingRaw, params));
}
