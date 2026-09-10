import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parse, type ParseError } from 'jsonc-parser';
import { linkHomeAsset, optionalText } from '../host/provider-home';
import type { OpencodeConfigFile } from './config';
import type { OpencodeSkill } from './server';

export async function prepareOpencodeHome(
  config: OpencodeConfigFile,
  skills: OpencodeSkill[],
  env: Record<string, string>
): Promise<string> {
  const source = join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), '.config'), 'opencode');
  let inherited: Record<string, unknown> = {};
  for (const filename of ['config.json', 'opencode.json', 'opencode.jsonc']) {
    const text = await optionalText(join(source, filename));
    if (text === null) continue;
    const errors: ParseError[] = [];
    const value: unknown = parse(text, errors, { allowTrailingComma: true });
    if (errors.length || !value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`Invalid OpenCode ${filename}.`);
    inherited = { ...inherited, ...value };
  }
  const object = (value: unknown): Record<string, unknown> => {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid OpenCode configuration object.');
    return value as Record<string, unknown>;
  };
  for (const key of ['instructions', 'plugin']) {
    const values = inherited[key];
    if (!Array.isArray(values)) continue;
    inherited[key] = values.map((value: unknown) => {
      if (typeof value !== 'string') return value;
      if (key === 'plugin' && !value.startsWith('.')) return value;
      return isAbsolute(value) || value.startsWith('~') || /^https?:/.test(value)
        ? value
        : resolve(source, value);
    });
  }
  const configHome = await mkdtemp(join(tmpdir(), 'switch-opencode-'));
  const target = join(configHome, 'opencode');
  await mkdir(target, { recursive: true, mode: 0o700 });
  const settings: Record<string, unknown> = {
    ...inherited,
    ...config,
    mcp: { ...object(inherited.mcp), ...config.mcp },
    permission:
      typeof inherited.permission === 'string'
        ? inherited.permission
        : { ...config.permission, ...object(inherited.permission) },
  };
  for (const name of ['skills', 'agents', 'commands', 'plugins'])
    await linkHomeAsset(join(source, name), join(target, name));
  // Managed skills use a separate search directory so user files are never overwritten.
  const nativeSkills = object(inherited.skills);
  const paths = nativeSkills.paths ?? [];
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== 'string'))
    throw new Error('Invalid OpenCode skill paths.');
  const skillPaths = paths.map((path: string) =>
    path.startsWith('~') ? path : resolve(source, path)
  );
  if (inherited.skills !== undefined) settings.skills = { ...nativeSkills, paths: skillPaths };
  if (skills.length) {
    const skillRoot = join(configHome, 'managed-skills');
    for (const skill of skills) {
      if (!/^[a-zA-Z0-9_-]+$/.test(skill.name)) throw new Error('Invalid managed skill name.');
      const dir = join(skillRoot, skill.name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'SKILL.md'), skill.content);
    }
    settings.skills = {
      ...nativeSkills,
      paths: [...skillPaths, skillRoot],
    };
  }
  await writeFile(join(target, 'opencode.json'), JSON.stringify(settings), { mode: 0o600 });
  return configHome;
}
