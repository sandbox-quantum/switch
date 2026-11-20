import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { RuntimeMode } from '../adapter';
import { dirMode } from '../host/host-permissions';
import { linkHomeAsset, linkSkills, optionalText } from '../host/provider-home';
import { replaceFile } from '../host/replace-file';
import type { CodexSandboxMode } from './protocol';

/**
 * The sandbox a managed agent's sessions fall back to when neither the
 * execution host's Codex configuration nor the agent's names one. Codex's own
 * default is read-only, which on a machine with no Codex configuration (a
 * cloud machine the agent controller runs on, say) leaves an agent unable to
 * write in its own directory: an agent that bypasses permissions gets full
 * access, any other (auto mode included) may write in its workspace.
 */
export function managedCodexSandbox(runtimeMode: RuntimeMode): CodexSandboxMode {
  return runtimeMode === 'full-access' ? 'danger-full-access' : 'workspace-write';
}

/**
 * Native rollouts remain in the persistent session directory on the execution
 * host. `keyringLogin` is set when the source home has no auth.json to copy:
 * the machine's login, if Codex has one, is then in the OS keyring, and a
 * session with no login of its own is handed it as it starts
 * (`CodexKeyringLogin`). A copy the session already has is left alone, since
 * Codex may still read it.
 *
 * The session's `sandbox_mode` is the host configuration's when it names one,
 * then the agent's, then `defaultSandbox` (null leaves Codex's own default).
 * The host's comes first so that a machine its owner set to `read-only` stays
 * read-only whatever the agent's permission settings (CHOO-4118).
 */
export async function prepareCodexSessionHome(input: {
  root: string;
  sessionId: string;
  sourceHome: string;
  config: string;
  defaultSandbox: CodexSandboxMode | null;
}): Promise<{ home: string; keyringLogin: boolean }> {
  const key = createHash('sha256').update(input.sessionId).digest('hex');
  const home = join(input.root, key);
  await mkdir(home, { recursive: true, mode: dirMode(0o700) });
  await chmod(home, dirMode(0o700));
  const keyringLogin = !(await hasCodexAuthFile(input.sourceHome));
  if (!keyringLogin) await copyCodexAuthenticationOnce(home, input.sourceHome);
  const sourceConfig = await optionalText(join(input.sourceHome, 'config.toml'));
  const hostConfig = sourceConfig ? parse(sourceConfig) : {};
  const config = { ...hostConfig, ...parse(input.config) };
  if ('sandbox_mode' in hostConfig) config.sandbox_mode = hostConfig.sandbox_mode;
  else if (!('sandbox_mode' in config) && input.defaultSandbox)
    config.sandbox_mode = input.defaultSandbox;
  // The session host registers its own `switch` server; an entry of that name
  // in the user's config would be merged into it rather than replaced.
  const servers = config.mcp_servers as Record<string, unknown> | undefined;
  if (servers) delete servers.switch;
  // The connector plugin Switch used to ship; kept off for installs that still have it.
  const plugins = config.plugins as Record<string, { enabled?: boolean }> | undefined;
  for (const [name, plugin] of Object.entries(plugins ?? {})) {
    if (name.includes('switch-connector')) plugin.enabled = false;
  }
  await writeFile(join(home, 'config.toml'), stringify(config), { mode: 0o600 });
  for (const name of ['AGENTS.md', 'rules', 'plugins', 'hooks.json'])
    await linkHomeAsset(join(input.sourceHome, name), join(home, name));
  // Earlier builds wrote the Switch skill here; it now arrives as developer
  // instructions, and a leftover copy would only be read again by shell.
  await rm(join(home, 'skills', 'switch'), { recursive: true, force: true });
  await linkSkills(join(input.sourceHome, 'skills'), join(home, 'skills'));
  return { home, keyringLogin };
}

export const codexHomeNotAbsolute = (home: string) =>
  `Set CODEX_HOME to an absolute path. It is ${JSON.stringify(home)}, which Codex reads from whichever directory it starts in, so Switch cannot tell which Codex home its sessions would use.`;

/**
 * The Codex home a session takes its login and configuration from; sign-in
 * checks look here too. A relative CODEX_HOME is refused rather than
 * resolved: Codex reads one from whichever directory it starts in, and
 * Console, the agent controller, a session's host and the Codex a check runs
 * each start in a different one, so no one resolution would be the home both
 * sessions and the check mean.
 */
export function codexSourceHome(env: Readonly<Record<string, string | undefined>>): string {
  const configured = env.CODEX_HOME;
  if (configured && !isAbsolute(configured)) throw new Error(codexHomeNotAbsolute(configured));
  return configured || join(homedir(), '.codex');
}

/** Whether a Codex home keeps its login in auth.json, the only form a session copies. */
export async function hasCodexAuthFile(home: string): Promise<boolean> {
  try {
    return (await stat(join(home, 'auth.json'))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new Error('Could not load the execution-host Codex login.', { cause: error });
  }
}

/** A resumed session keeps its refreshed login; new sessions copy only auth. */
async function copyCodexAuthenticationOnce(home: string, sourceHome: string): Promise<void> {
  try {
    await readFile(join(home, 'auth.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await copyFile(join(sourceHome, 'auth.json'), join(home, 'auth.json'));
      await chmod(join(home, 'auth.json'), 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not load the execution-host Codex login.', { cause });
    }
  }
}

async function replacePrivateFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await replaceFile(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Keeps a native token refresh until the source login changes, then replaces
 * the session's login with the new one.
 */
export async function refreshCodexAuthentication(home: string, sourceHome: string): Promise<void> {
  const authPath = join(home, 'auth.json');
  const sourceAuth = await optionalText(join(sourceHome, 'auth.json'));
  if (sourceAuth === null) return;
  const fingerprint = createHash('sha256').update(sourceAuth).digest('hex');
  const marker = join(home, '.switch-auth-source');
  const previous = await optionalText(marker);
  const auth = await lstat(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (auth && !auth.isFile()) throw new Error('Codex auth.json must be a regular file.');
  if (!auth || (previous !== null && previous !== fingerprint))
    await replacePrivateFile(authPath, sourceAuth);
  await replacePrivateFile(marker, fingerprint);
}
