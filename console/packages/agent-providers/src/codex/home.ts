import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, stringify } from 'smol-toml';
import { linkHomeAsset, linkSkills, optionalText } from '../host/provider-home';

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
  // A resumed session keeps its refreshed login; new sessions copy only auth.
  try {
    await readFile(join(home, 'auth.json'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    try {
      await copyFile(join(input.sourceHome, 'auth.json'), join(home, 'auth.json'));
      await chmod(join(home, 'auth.json'), 0o600);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('Could not load the execution-host Codex login.', { cause });
    }
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
