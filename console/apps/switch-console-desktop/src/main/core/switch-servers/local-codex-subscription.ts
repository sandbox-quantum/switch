import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const subscriptionSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().trim().min(1),
    id_token: z.string().trim().min(1),
  }),
});

export function localCodexAuthPath(): string {
  return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
}

export async function readLocalCodexSubscription(path: string) {
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error('Could not read the local Codex sign-in file. Check its permissions.');
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) {
      throw new Error('The local Codex sign-in must be a JSON file smaller than 16 KiB.');
    }
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error('The local Codex sign-in file is too large.');
    const credential = buffer.toString('utf8', 0, bytesRead);
    let parsed: unknown;
    try {
      parsed = JSON.parse(credential);
    } catch {
      throw new Error('Waiting for Codex to finish writing its sign-in file.');
    }
    if (!subscriptionSchema.safeParse(parsed).success) {
      throw new Error('No subscription login found in this file. Sign in to Codex with ChatGPT.');
    }
    return credential;
  } finally {
    await file.close();
  }
}

export async function getLocalCodexSubscription() {
  const path = localCodexAuthPath();
  const credential = await readLocalCodexSubscription(path);
  return { path, status: credential ? ('ready' as const) : ('missing' as const) };
}
