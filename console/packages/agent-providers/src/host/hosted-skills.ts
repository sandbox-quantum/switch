import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';

export const MAX_HOSTED_SKILL_BYTES = 32 * 1024;
const SKILL_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}(\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}){0,7}$/;

/** Providers whose agent reads skills from a directory bootstrap can install into. */
export const HOSTED_SKILL_PROVIDERS = ['claude', 'codex', 'opencode'] as const;
type HostedSkillProvider = (typeof HOSTED_SKILL_PROVIDERS)[number];

export const hostedSkillsSchema = z
  .array(
    z
      .strictObject({
        slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
        files: z.record(
          z.string().regex(SKILL_PATH),
          z.string().refine((value) => !value.includes('\0'), 'must not contain NUL')
        ),
      })
      .refine((skill) => 'SKILL.md' in skill.files, 'must include SKILL.md')
  )
  .min(1)
  .max(16)
  .refine(
    (skills) => new Set(skills.map((skill) => skill.slug)).size === skills.length,
    'skill names must be unique'
  )
  .refine(
    (skills) =>
      skills
        .flatMap((skill) => Object.values(skill.files))
        .reduce((total, content) => total + Buffer.byteLength(content), 0) <=
      MAX_HOSTED_SKILL_BYTES,
    `skills must fit within ${MAX_HOSTED_SKILL_BYTES} bytes`
  );
export type HostedSkills = z.infer<typeof hostedSkillsSchema>;

export function supportsHostedSkills(provider: string): provider is HostedSkillProvider {
  return (HOSTED_SKILL_PROVIDERS as readonly string[]).includes(provider);
}

/** The global skills directory each provider reads under the hosted agent's environment. */
export function hostedSkillsDirectory(
  provider: HostedSkillProvider,
  env: NodeJS.ProcessEnv
): string {
  const directory = configuredSkillsDirectory(provider, env);
  if (!directory) throw new Error(`The ${provider} home for connection skills is not configured.`);
  return directory;
}

function configuredSkillsDirectory(
  provider: HostedSkillProvider,
  env: NodeJS.ProcessEnv
): string | null {
  const base = {
    claude: env.CLAUDE_CONFIG_DIR,
    codex: env.CODEX_HOME || (env.HOME && join(env.HOME, '.codex')),
    opencode: env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, 'opencode'),
  }[provider];
  return base ? join(base, 'skills') : null;
}

/**
 * The connection skills a Switch from before service grants listed with each
 * cloud agent, which bootstrap installed into the provider's skills folder.
 * Sessions now take them from the agent's grants, so a copy left from then
 * would be loaded twice.
 */
const FORMERLY_INSTALLED_SKILLS = ['github'];

/** Remove the connection skills an earlier bootstrap installed for this agent. */
export async function removeFormerlyInstalledSkills(
  provider: HostedSkillProvider,
  env: NodeJS.ProcessEnv
): Promise<void> {
  // Nothing was installed where no provider home is configured.
  const directory = configuredSkillsDirectory(provider, env);
  if (!directory) return;
  for (const slug of FORMERLY_INSTALLED_SKILLS)
    await rm(join(directory, slug), { recursive: true, force: true });
}

/** Replace each granted skill so a restart always carries the deployment's copy. */
export async function installHostedSkills(directory: string, skills: HostedSkills): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const skill of skills) {
    const staging = join(directory, `.${skill.slug}.${randomUUID()}`);
    try {
      for (const [path, content] of Object.entries(skill.files)) {
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { mode: 0o600, flag: 'wx' });
      }
      const destination = join(directory, skill.slug);
      await rm(destination, { recursive: true, force: true });
      await rename(staging, destination);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}
