import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export async function prepareGeminiHome(input: {
  root: string;
  sessionId: string;
  sourceHome: string;
  context: string;
  mcpServerNames: string[];
}): Promise<string> {
  const base = join(input.root, createHash('sha256').update(input.sessionId).digest('hex'));
  const home = join(base, '.gemini');
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  let source: { security?: { auth?: { selectedType?: string } } } = {};
  try {
    source = JSON.parse(await readFile(join(input.sourceHome, 'settings.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Gemini also supports the OS keychain and API credentials supplied in env.
  for (const name of ['oauth_creds.json', 'google_accounts.json']) {
    try {
      try {
        await readFile(join(home, name));
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await copyFile(join(input.sourceHome, name), join(home, name));
      await chmod(join(home, name), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await writeFile(
    join(home, 'settings.json'),
    JSON.stringify({
      security: { auth: { selectedType: source.security?.auth?.selectedType ?? 'gemini-api-key' } },
      telemetry: { enabled: false },
      mcp: { allowed: input.mcpServerNames },
      tools: { exclude: ['ask_user'] },
    }),
    { mode: 0o600 }
  );
  await writeFile(join(home, 'GEMINI.md'), input.context);
  return base;
}
