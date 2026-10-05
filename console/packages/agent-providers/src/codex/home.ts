import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { linkHomeAsset, linkSkills, optionalText } from '../host/provider-home';

/** Native rollouts remain in the persistent session directory on the execution host. */
export async function prepareCodexSessionHome(input: {
  root: string;
  sessionId: string;
  sourceHome: string;
  config: string;
  /**
   * `refresh` replaces the session's login whenever the source login changes
   * (a hosted worker, whose owner can reconnect the provider); `copy-once`
   * keeps whatever the session refreshed after its first copy.
   */
  auth: 'copy-once' | 'refresh';
}): Promise<string> {
  const key = createHash('sha256').update(input.sessionId).digest('hex');
  const home = join(input.root, key);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  if (input.auth === 'refresh') await refreshCodexAuthentication(home, input.sourceHome);
  else await copyCodexAuthenticationOnce(home, input.sourceHome);
  const sourceConfig = await optionalText(join(input.sourceHome, 'config.toml'));
  const config = { ...(sourceConfig ? parse(sourceConfig) : {}), ...parse(input.config) };
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
  return home;
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
    await rename(temporary, path);
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
