import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AcpLaunch, AcpLaunchInput } from '../acp/hooks';

export const AIDER_SIGN_IN =
  'Set an LLM API key for Aider on the execution host (e.g. OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, DEEPSEEK_API_KEY), or configure ~/.aider.conf.yml.';

export function aiderConfigPath(env: Record<string, string>): string {
  return env.AIDER_CONFIG_PATH || join(env.HOME || homedir(), '.aider.conf.yml');
}

export async function aiderSignedIn(env: Record<string, string>): Promise<boolean> {
  // Check common model API keys supported by Aider
  if (
    env.OPENAI_API_KEY?.trim() ||
    env.ANTHROPIC_API_KEY?.trim() ||
    env.GEMINI_API_KEY?.trim() ||
    env.DEEPSEEK_API_KEY?.trim() ||
    env.GROQ_API_KEY?.trim() ||
    env.OLLAMA_API_BASE?.trim() ||
    env.OPENROUTER_API_KEY?.trim()
  ) {
    return true;
  }

  // Check config file
  const config = aiderConfigPath(env);
  if (!existsSync(config)) return false;

  try {
    const text = await readFile(config, 'utf8');
    return text.includes('api-key') || text.includes('model:');
  } catch {
    return false;
  }
}

export async function aiderLaunch(input: AcpLaunchInput): Promise<AcpLaunch> {
  return {
    command: input.binaryPath,
    args: ['--acp'],
    env: input.env,
  };
}
