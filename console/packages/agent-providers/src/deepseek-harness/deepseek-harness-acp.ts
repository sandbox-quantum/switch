import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const DSH_LOGIN = 'dsh auth login';

async function readOptionalFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

function parseKeyFromText(text: string): string | undefined {
  const envMatch = text.match(/^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*["']?([^\s"']+)["']?/m);
  if (envMatch?.[1]?.trim()) return envMatch[1].trim();

  const yamlMatch = text.match(/(?:DEEPSEEK_API_KEY|apiKey)\s*:\s*["']?([^\s"'}\],]+)["']?/);
  if (yamlMatch?.[1]?.trim()) return yamlMatch[1].trim();

  return undefined;
}

export async function findDeepseekApiKey(
  env: Record<string, string | undefined>,
  cwd?: string
): Promise<string | undefined> {
  if (env.DEEPSEEK_API_KEY?.trim()) {
    return env.DEEPSEEK_API_KEY.trim();
  }

  const userHome = env.HOME || env.USERPROFILE || homedir();
  const dshHome = env.DSH_HOME?.trim()
    ? isAbsolute(env.DSH_HOME)
      ? env.DSH_HOME
      : resolve(cwd ?? '.', env.DSH_HOME)
    : join(userHome, '.dsh');

  const candidates = [
    cwd ? join(cwd, '.env') : undefined,
    join(dshHome, '.credentials.yaml'),
    join(dshHome, '.env'),
    join(userHome, '.deepseek'),
  ].filter((p): p is string => Boolean(p));

  for (const filePath of candidates) {
    const content = await readOptionalFile(filePath);
    if (content) {
      const key = parseKeyFromText(content);
      if (key) return key;
    }
  }

  return undefined;
}

export const deepseekHarnessAcp: AcpProviderHooks = {
  provider: 'deepseek-harness',
  label: 'DeepSeek Harness',
  defaultBinary: 'dsh',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--profile', 'acp'],
    env,
  }),
  loginCommand: DSH_LOGIN,
  inheritEnv: ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'DSH_HOME'],
  checkSignIn: async ({ handshake, env, cwd }) => {
    const configuredKey = await findDeepseekApiKey(env, cwd);
    if (configuredKey) {
      try {
        await handshake();
        return readiness('authenticated', 'Signs in with the DeepSeek API key it was given.');
      } catch (error) {
        if (/sign.?in|auth|unauthenticated|unauthorized|login/i.test(String(error))) {
          return readiness('unauthenticated', signInWith(DSH_LOGIN));
        }
        return readiness('authenticated', 'Signs in with the DeepSeek API key it was given.');
      }
    }

    try {
      const result = await handshake();
      if (Array.isArray(result.authMethods) && result.authMethods.length > 0) {
        return readiness('unauthenticated', signInWith(DSH_LOGIN));
      }
      // dsh-acp returns authMethods: [] unconditionally even when unauthenticated.
      // Since no DEEPSEEK_API_KEY was found in environment or local credential files,
      // report unauthenticated with the login hint to avoid false-positive sign-ins.
      return readiness('unauthenticated', signInWith(DSH_LOGIN));
    } catch (error) {
      if (/sign.?in|auth|unauthenticated|unauthorized|login/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(DSH_LOGIN));
      }
      return readiness('unknown', signInWith(DSH_LOGIN));
    }
  },
  itemType: (toolCall) => {
    const title = toolCall.title?.toLowerCase();
    if (
      title === 'write' ||
      title === 'edit' ||
      title === 'write_file' ||
      title === 'edit_file' ||
      title === 'apply_patch'
    ) {
      return 'file_change';
    }
    if (
      title === 'bash' ||
      title === 'command' ||
      title === 'exec' ||
      title === 'shell' ||
      title === 'pwsh'
    ) {
      return 'command_execution';
    }
    return undefined;
  },
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
