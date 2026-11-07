import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

export const PI_SIGN_IN =
  'Sign in to Pi CLI on the execution host with `pi login`, or set an API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY).';

export function piConfigPath(env: Record<string, string>): string {
  return env.PI_CONFIG_PATH || join(env.HOME || homedir(), '.pi', 'config.json');
}

export async function piSignedIn(env: Record<string, string>): Promise<boolean> {
  // Check common model API keys supported by Pi
  if (
    env.ANTHROPIC_API_KEY?.trim() ||
    env.OPENAI_API_KEY?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.GROQ_API_KEY?.trim() ||
    env.MISTRAL_API_KEY?.trim()
  ) {
    return true;
  }

  // Check config file
  const config = piConfigPath(env);
  if (!existsSync(config)) return false;

  try {
    const text = await readFile(config, 'utf8');
    const parsed = JSON.parse(text) as { token?: string; apiKey?: string; defaultModel?: string };
    return Boolean(parsed.token || parsed.apiKey);
  } catch {
    return false;
  }
}

export async function piLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  return {
    command: input.binaryPath,
    args: ['--mode', 'acp'],
    env: input.env,
  };
}
