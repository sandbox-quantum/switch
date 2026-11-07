import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

export const AMP_SIGN_IN =
  'Sign in to Amp CLI on the execution host with `amp login`, or set AMP_API_KEY / SOURCEGRAPH_TOKEN.';

export function ampConfigPath(env: Record<string, string>): string {
  return env.AMP_CONFIG_PATH || join(env.HOME || homedir(), '.amp', 'auth.json');
}

export async function ampSignedIn(env: Record<string, string>): Promise<boolean> {
  // Check API keys or Sourcegraph tokens
  if (
    env.AMP_API_KEY?.trim() ||
    env.SOURCEGRAPH_TOKEN?.trim() ||
    env.SRC_ACCESS_TOKEN?.trim()
  ) {
    return true;
  }

  // Check config file
  const config = ampConfigPath(env);
  if (!existsSync(config)) return false;

  try {
    const text = await readFile(config, 'utf8');
    const parsed = JSON.parse(text) as { token?: string; apiKey?: string; user?: string };
    return Boolean(parsed.token || parsed.apiKey || parsed.user);
  } catch {
    return false;
  }
}

export async function ampLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  return {
    command: input.binaryPath,
    args: ['acp'],
    env: input.env,
  };
}
