import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { shareLoginDirectory } from '../host/host-permissions';
import { linkHomeAsset, linkSkills, optionalText } from '../host/provider-home';

/** Native rollouts remain in the persistent session directory on the execution host. */
export async function prepareCodexSessionHome(input: {
  root: string;
  sessionId: string;
  sourceHome: string;
  config: string;
  /**
   * `shared` links the session's login to the source login, which its owner
   * can reconnect (a host whose login Switch holds); `copy-once` keeps
   * whatever the session refreshed after its first copy.
   */
  auth: 'copy-once' | 'shared';
}): Promise<string> {
  const key = createHash('sha256').update(input.sessionId).digest('hex');
  const home = join(input.root, key);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  await shareLoginDirectory(home);
  if (input.auth === 'shared') await linkCodexAuthentication(home, input.sourceHome);
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

/**
 * Points the session's auth.json at the host's, so every session refreshes
 * the one login: Codex rotates the refresh token on use, and separate copies
 * would each spend it and sign the others out with `refresh_token_reused`.
 * Codex writes a refreshed login through the link, and a reconnected login
 * replaced on the host is what every session reads next.
 */
export async function linkCodexAuthentication(home: string, sourceHome: string): Promise<void> {
  const source = join(sourceHome, 'auth.json');
  const authPath = join(home, 'auth.json');
  try {
    await lstat(source);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const current = await readlink(authPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'EINVAL') return null;
    throw error;
  });
  if (current !== source) {
    const temporary = `${authPath}.${randomUUID()}.tmp`;
    try {
      await symlink(source, temporary, 'file');
      await rename(temporary, authPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  await rm(join(home, '.switch-auth-source'), { force: true });
}
