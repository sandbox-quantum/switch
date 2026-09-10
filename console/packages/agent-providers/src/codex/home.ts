import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Persistent rollouts stay beside the Console database, outside the working tree. */
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
      throw new Error(
        'Could not load the Codex login. Run `codex login` before starting this session.',
        { cause }
      );
    }
  }
  await writeFile(join(home, 'config.toml'), input.config, { mode: 0o600 });
  const skillDir = join(home, 'skills', 'switch');
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, 'SKILL.md'), input.skill);
  return home;
}
