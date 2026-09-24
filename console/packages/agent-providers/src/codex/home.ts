import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { linkHomeAsset, linkSkills, optionalText } from '../host/provider-home';

async function replacePrivateFile(path: string, value: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Native rollouts remain in the persistent session directory on the execution host. */
export async function prepareCodexSessionHome(input: {
  root: string;
  sessionId: string;
  sourceHome: string;
  config: string;
  skill: string;
}): Promise<string> {
  const key = createHash('sha256').update(input.sessionId).digest('hex');
  const home = join(input.root, key);
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  const authPath = join(home, 'auth.json');
  const sourceAuth = await optionalText(join(input.sourceHome, 'auth.json'));
  if (sourceAuth !== null) {
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
  const sourceConfig = await optionalText(join(input.sourceHome, 'config.toml'));
  const config = { ...(sourceConfig ? parse(sourceConfig) : {}), ...parse(input.config) };
  const servers = config.mcp_servers as Record<string, unknown> | undefined;
  if (servers) delete servers.switch;
  const plugins = config.plugins as Record<string, { enabled?: boolean }> | undefined;
  for (const [name, plugin] of Object.entries(plugins ?? {})) {
    if (name.includes('switch-connector')) plugin.enabled = false;
  }
  await writeFile(join(home, 'config.toml'), stringify(config), { mode: 0o600 });
  for (const name of ['AGENTS.md', 'rules', 'plugins', 'hooks.json'])
    await linkHomeAsset(join(input.sourceHome, name), join(home, name));
  const skillDir = join(home, 'skills', 'switch');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), input.skill);
  await linkSkills(join(input.sourceHome, 'skills'), join(home, 'skills'));
  return home;
}
