import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
  await refreshCodexAuthentication(home, input.sourceHome);
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

export async function refreshCodexAuthentication(home: string, sourceHome: string): Promise<void> {
  const authPath = join(home, 'auth.json');
  const sourceAuth = await optionalText(join(sourceHome, 'auth.json'));
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
}

export async function migrateCodexRollout(input: {
  home: string;
  sourceHome: string;
  nativeSessionId: string;
  sessionId: string;
}): Promise<void> {
  if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(input.nativeSessionId)) return;
  const find = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    );
    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) matches.push(...(await find(join(directory, entry.name))));
      else if (
        entry.isFile() &&
        entry.name.startsWith('rollout-') &&
        entry.name.endsWith(`-${input.nativeSessionId}.jsonl`)
      )
        matches.push(join(directory, entry.name));
    }
    return matches;
  };
  if ((await find(join(input.home, 'sessions'))).length) return;
  const sourceRoot = join(input.sourceHome, 'sessions');
  const matches = await find(sourceRoot);
  if (!matches.length) return;
  if (matches.length !== 1)
    throw new Error('Multiple Codex rollouts match the saved conversation.');
  const source = matches[0]!;
  const destination = join(input.home, 'sessions', source.slice(sourceRoot.length + 1));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await rename(source, destination);
  console.warn(
    `Moved the saved Codex rollout into the prepared home for session ${input.sessionId}.`
  );
}
