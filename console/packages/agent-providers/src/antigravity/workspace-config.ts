import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { McpServerSpec } from '../adapter';

/**
 * Antigravity has no per-session MCP flag. It discovers servers from a
 * customization root: `<workspace>/.agents/mcp_config.json` for the session's
 * own directory, or `~/.gemini/config/mcp_config.json` for the whole machine.
 * The workspace file is the only one scoped to a single session's cwd, and it
 * keeps the caller's server names intact — a `plugins/<name>/mcp_config.json`
 * would work too but the CLI renames its servers to `<plugin>_<server>`.
 */
export const workspaceMcpConfigPath = (cwd: string) => join(cwd, '.agents', 'mcp_config.json');

/** `~/.gemini/antigravity-cli/settings.json`, the only file whose `permissions.allow` the CLI honours. */
export const settingsPath = (home: string) =>
  join(home, '.gemini', 'antigravity-cli', 'settings.json');

type Json = Record<string, unknown>;

async function readJson(path: string): Promise<{ raw: string | null; value: Json }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { raw: null, value: {} };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return { raw, value: parsed as Json };
  } catch {
    // A file we cannot parse is not ours to merge into; replace it and put the
    // original back when the session stops.
  }
  return { raw, value: {} };
}

async function writeAtomic(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.switch-${process.pid}-${Date.now()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600 });
  await rename(temporary, path);
}

/** Restores the exact bytes a file had before a session touched it, or removes it. */
export async function restoreFile(path: string, original: string | null): Promise<void> {
  if (original === null) await rm(path, { force: true });
  else await writeAtomic(path, original);
}

function mcpEntry(spec: McpServerSpec, env: Record<string, string>): Json {
  if (spec.transport === 'http')
    return { serverUrl: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
  const forwarded: Record<string, string> = { ...(spec.env ?? {}) };
  for (const name of spec.envVars ?? []) {
    const value = env[name];
    if (value !== undefined) forwarded[name] = value;
  }
  return {
    command: spec.command,
    args: spec.args,
    ...(Object.keys(forwarded).length > 0 ? { env: forwarded } : {}),
  };
}

/**
 * Merges the session's servers into the workspace config, leaving anything the
 * user already had in place, and returns the bytes to restore on stop.
 */
export async function registerWorkspaceMcpServers(input: {
  cwd: string;
  servers: Record<string, McpServerSpec>;
  env: Record<string, string>;
}): Promise<string | null> {
  const path = workspaceMcpConfigPath(input.cwd);
  const { raw, value } = await readJson(path);
  const existing =
    value.mcpServers && typeof value.mcpServers === 'object' && !Array.isArray(value.mcpServers)
      ? (value.mcpServers as Json)
      : {};
  const merged: Json = { ...existing };
  for (const [name, spec] of Object.entries(input.servers))
    merged[name] = mcpEntry(spec, input.env);
  await writeAtomic(path, `${JSON.stringify({ ...value, mcpServers: merged }, null, 2)}\n`);
  return raw;
}

/**
 * Headless Antigravity auto-denies every tool that would need a prompt,
 * including the caller's own MCP servers. A session's MCP servers are the ones
 * Switch registered for it, so they are allow-listed even in the mode that asks
 * about everything else; nothing else is.
 */
export async function allowMcpServers(input: {
  home: string;
  names: string[];
}): Promise<{ path: string; added: string[] }> {
  const path = settingsPath(input.home);
  const { value } = await readJson(path);
  const permissions =
    value.permissions && typeof value.permissions === 'object'
      ? ({ ...(value.permissions as Json) } as Json)
      : {};
  const allow = Array.isArray(permissions.allow) ? [...(permissions.allow as unknown[])] : [];
  const added: string[] = [];
  for (const name of input.names) {
    const rule = `mcp(${name}/*)`;
    if (allow.includes(rule)) continue;
    allow.push(rule);
    added.push(rule);
  }
  if (added.length === 0) return { path, added };
  permissions.allow = allow;
  await writeAtomic(path, `${JSON.stringify({ ...value, permissions }, null, 2)}\n`);
  return { path, added };
}

/** Drops exactly the rules this session added, keeping everything else. */
export async function revokeMcpAllowRules(path: string, rules: string[]): Promise<void> {
  if (rules.length === 0) return;
  const { raw, value } = await readJson(path);
  if (raw === null) return;
  const permissions =
    value.permissions && typeof value.permissions === 'object'
      ? ({ ...(value.permissions as Json) } as Json)
      : {};
  const allow = Array.isArray(permissions.allow) ? (permissions.allow as unknown[]) : [];
  const kept = allow.filter((rule) => !rules.includes(rule as string));
  if (kept.length === allow.length) return;
  if (kept.length === 0) delete permissions.allow;
  else permissions.allow = kept;
  const next = { ...value };
  if (Object.keys(permissions).length === 0) delete next.permissions;
  else next.permissions = permissions;
  await writeAtomic(path, `${JSON.stringify(next, null, 2)}\n`);
}
