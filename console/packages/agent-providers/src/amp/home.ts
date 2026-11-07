import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseJsonc } from 'jsonc-parser';
import type { McpServerSpec } from '../adapter';
import { linkHomeAsset, optionalText } from '../host/provider-home';
import { AMP_APPROVAL_PLUGIN_SOURCE, AMP_PLUGIN_FILENAME } from './approval-plugin';

/**
 * The directory Amp reads its user configuration from: `$XDG_CONFIG_HOME` when
 * set, else `~/.config` (`%USERPROFILE%\.config` on Windows), as Amp resolves it.
 */
export function ampUserConfigRoot(env: Readonly<Record<string, string | undefined>>): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  const home =
    env.HOME || (process.platform === 'win32' ? env.USERPROFILE : undefined) || homedir();
  return join(home, '.config');
}

/** Where a session's Amp configuration lives: under the state directory, never in the working tree. */
export function ampSessionsRoot(env: Readonly<Record<string, string | undefined>>): string {
  const home =
    env.HOME || (process.platform === 'win32' ? env.USERPROFILE : undefined) || homedir();
  const state = env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(state, 'switch', 'amp', 'sessions');
}

export function ampSessionDirectory(root: string, sessionId: string): string {
  return join(root, createHash('sha256').update(sessionId).digest('hex').slice(0, 24));
}

/**
 * Amp's `amp.mcpServers` entry for a server. Amp expands `${NAME}` against
 * its own environment when it starts a stdio server, so a forwarded variable
 * is named, not resolved into the settings file.
 */
export function ampMcpServer(spec: McpServerSpec, env: Record<string, string>): unknown {
  if (spec.transport === 'stdio') {
    const forwarded: Record<string, string> = {};
    for (const name of spec.envVars ?? []) if (env[name] !== undefined) forwarded[name] = `\${${name}}`;
    const resolved = { ...forwarded, ...spec.env };
    return {
      command: spec.command,
      args: spec.args,
      ...(Object.keys(resolved).length > 0 ? { env: resolved } : {}),
    };
  }
  return { url: spec.url, ...(spec.headers ? { headers: spec.headers } : {}) };
}

export interface AmpSessionHome {
  /** The `XDG_CONFIG_HOME` the session's Amp runs with. */
  configHome: string;
  /** The `--settings-file` the session's Amp reads. */
  settingsFile: string;
}

/**
 * Prepares a session's Amp configuration.
 *
 * Amp loads plugins only from `$XDG_CONFIG_HOME/amp/plugins/` or the working
 * tree's `.amp/plugins/`, and the approval plugin must not land in anyone's
 * repository, so the session runs with its own `XDG_CONFIG_HOME`. Everything
 * else under the user's configuration root is linked into it, so the tools
 * the agent runs (git, gh, …) still find theirs; under `amp/`, everything but
 * the settings file and the plugins is linked too, so a saved sign-in there
 * is kept. The user's own plugins are not: one that opens a dialog would stop
 * the thread under `amp -x`.
 *
 * The settings file is the user's own, with the session's MCP servers over
 * its `amp.mcpServers` and update checks and notifications off; the Switch
 * server's headers carry the agent's token, so it is private to the user.
 */
export async function prepareAmpSessionHome(input: {
  directory: string;
  env: Readonly<Record<string, string | undefined>>;
  mcpServers: Record<string, McpServerSpec>;
  sessionEnv: Record<string, string>;
}): Promise<AmpSessionHome> {
  const userRoot = ampUserConfigRoot(input.env);
  const configHome = join(input.directory, 'xdg');
  const ampDirectory = join(configHome, 'amp');
  const pluginsDirectory = join(ampDirectory, 'plugins');
  await mkdir(input.directory, { recursive: true, mode: 0o700 });
  await chmod(input.directory, 0o700);
  await mkdir(pluginsDirectory, { recursive: true, mode: 0o700 });
  await writeFile(join(pluginsDirectory, AMP_PLUGIN_FILENAME), AMP_APPROVAL_PLUGIN_SOURCE, {
    mode: 0o600,
  });

  for (const entry of await entries(userRoot)) {
    if (entry === 'amp') continue;
    await linkHomeAsset(join(userRoot, entry), join(configHome, entry));
  }
  for (const entry of await entries(join(userRoot, 'amp'))) {
    if (entry === 'plugins' || entry === 'settings.json' || entry === 'settings.jsonc') continue;
    await linkHomeAsset(join(userRoot, 'amp', entry), join(ampDirectory, entry));
  }

  const settings = await userSettings(join(userRoot, 'amp'));
  const servers = {
    ...(isObject(settings['amp.mcpServers']) ? settings['amp.mcpServers'] : {}),
    ...Object.fromEntries(
      Object.entries(input.mcpServers).map(([name, spec]) => [
        name,
        ampMcpServer(spec, input.sessionEnv),
      ])
    ),
  };
  const merged: Record<string, unknown> = {
    ...settings,
    'amp.mcpServers': servers,
    'amp.updates.mode': 'disabled',
    'amp.notifications.enabled': false,
  };
  const settingsFile = join(input.directory, 'settings.json');
  await writeFile(settingsFile, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  return { configHome, settingsFile };
}

/** Removes what `prepareAmpSessionHome` wrote, the settings file with the token first of all. */
export async function removeAmpSessionHome(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The user's Amp settings, `settings.json` or else `settings.jsonc`; `{}` without one. */
async function userSettings(ampDirectory: string): Promise<Record<string, unknown>> {
  for (const name of ['settings.json', 'settings.jsonc']) {
    const text = await optionalText(join(ampDirectory, name));
    if (text === null) continue;
    const errors: { error: number; offset: number }[] = [];
    const parsed: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
    if (errors.length > 0)
      throw new Error(
        `Amp's user settings file ${name} is not valid JSON (error ${errors[0]!.error} at offset ${errors[0]!.offset}); fix it or move it aside.`
      );
    if (!isObject(parsed)) throw new Error(`Amp's user settings file ${name} must hold an object.`);
    return parsed;
  }
  return {};
}
