import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { providerDisplayName } from '@shared/core/providers/agent-provider-registry';
import {
  getOpenCodeLoginCommand,
  localOpenCodeDatabasePath,
  readOpenCodeConsole,
} from './local-opencode-sign-in';

const subscriptionSchema = z.object({
  auth_mode: z.literal('chatgpt').optional(),
  OPENAI_API_KEY: z.null().optional(),
  tokens: z.object({
    access_token: z.string().trim().min(1),
    refresh_token: z.string().trim().min(1),
    id_token: z.string().trim().min(1),
  }),
});

export type LocalSignInProvider = 'codex' | 'opencode' | 'antigravity';

export function localProviderAuthPath(provider: LocalSignInProvider): string {
  switch (provider) {
    case 'codex':
      return join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    case 'opencode':
      return join(
        process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'),
        'opencode',
        'auth.json'
      );
    case 'antigravity':
      return join(
        process.env.GEMINI_HOME || join(homedir(), '.local', 'state', 'switch', 'antigravity-acp'),
        'antigravity-acp',
        'acp_token.json'
      );
    default:
      throw new Error('This provider does not support local sign-in files.');
  }
}

export async function readLocalProviderSignIn(provider: LocalSignInProvider, path: string) {
  if (provider === 'opencode') {
    const account = readOpenCodeConsole(localOpenCodeDatabasePath());
    if (account) return account;
  }
  const name = providerDisplayName(provider);
  let file;
  try {
    file = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read the local ${name} sign-in file. Check its permissions.`);
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384) {
      throw new Error(`The local ${name} sign-in must be a JSON file smaller than 16 KiB.`);
    }
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error(`The local ${name} sign-in file is too large.`);
    const credential = buffer.toString('utf8', 0, bytesRead);
    let parsed: unknown;
    try {
      parsed = JSON.parse(credential);
    } catch {
      throw new Error(`Waiting for ${name} to finish writing its sign-in file.`);
    }
    if (provider === 'codex' && !subscriptionSchema.safeParse(parsed).success) {
      throw new Error('No subscription login found in this file. Sign in to Codex with ChatGPT.');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Object.keys(parsed).length
    ) {
      throw new Error(`No sign-in data found in the local ${name} file. Sign in locally first.`);
    }
    return credential;
  } finally {
    await file.close();
  }
}

export async function getLocalProviderSignIn(provider: LocalSignInProvider) {
  if (provider === 'opencode') {
    const info = await getOpenCodeLoginCommand();
    const account = readOpenCodeConsole(localOpenCodeDatabasePath());
    const credential =
      account ?? (await readLocalProviderSignIn(provider, localProviderAuthPath(provider)));
    const path =
      account || (!credential && info.command === 'opencode console login')
        ? localOpenCodeDatabasePath()
        : localProviderAuthPath(provider);
    return { path, status: credential ? ('ready' as const) : ('missing' as const), ...info };
  }
  const path = localProviderAuthPath(provider);
  const credential = await readLocalProviderSignIn(provider, path);
  return { path, status: credential ? ('ready' as const) : ('missing' as const) };
}
