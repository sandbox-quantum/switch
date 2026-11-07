import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

/**
 * DeepSeek Harness has no login command: its Web app's Models page saves the
 * key to `$DSH_HOME/.credentials.yaml`, or `DEEPSEEK_API_KEY` is exported.
 */
export const DSH_LOGIN = 'dsh web';
export const DSH_KEY = 'DEEPSEEK_API_KEY';

const SIGN_IN_HINT = `${signInWith(DSH_LOGIN)} Save a DeepSeek API key on its Models page, or set ${DSH_KEY}.`;

/** `$DSH_HOME`, else `~/.dsh`, as dsh resolves it. */
export function dshHome(env: Record<string, string>): string {
  const configured = env.DSH_HOME?.trim();
  if (configured) return resolve(configured);
  return join(env.HOME?.trim() || homedir(), '.dsh');
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/** Whether a `.credentials.yaml` stores a non-empty `DEEPSEEK_API_KEY` under `refs:`. */
export function credentialsHaveKey(text: string): boolean {
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inRefs = /^refs\s*:\s*$/.test(line);
    else if (inRefs) {
      const match = /^\s+DEEPSEEK_API_KEY\s*:\s*(.*?)\s*$/.exec(line);
      if (match) return !/^(|''|""|~|null)$/.test(match[1]!);
    }
  }
  return false;
}

/** Whether a dotenv file sets a non-empty `DEEPSEEK_API_KEY`. */
export function dotenvHasKey(text: string): boolean {
  return text.split(/\r?\n/).some((line) => {
    const value = /^\s*(?:export\s+)?DEEPSEEK_API_KEY\s*=(.*)$/.exec(line)?.[1];
    return (
      value !== undefined &&
      value
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2')
        .trim() !== ''
    );
  });
}

/**
 * Whether dsh has a DeepSeek key where it looks for one, in its own order:
 * the credentials file, the environment, the project's `.env`, then
 * `$DSH_HOME/.env`. Nothing is started and no request is spent, so a key
 * found is not proven valid until a turn runs.
 */
export async function checkDshSignIn({
  cwd,
  env,
}: {
  cwd: string;
  env: Record<string, string>;
}): Promise<ProviderReadiness> {
  const home = dshHome(env);
  const credentials = await readText(join(home, '.credentials.yaml'));
  if (credentials !== undefined && credentialsHaveKey(credentials))
    return readiness('authenticated', 'Signed in with the DeepSeek key saved in DeepSeek Harness.');
  if (env[DSH_KEY]?.trim())
    return readiness('authenticated', `Signs in with the ${DSH_KEY} it was given.`);
  for (const file of [join(isAbsolute(cwd) ? cwd : resolve(cwd), '.env'), join(home, '.env')]) {
    const text = await readText(file);
    if (text !== undefined && dotenvHasKey(text))
      return readiness('authenticated', `Signs in with the ${DSH_KEY} in ${file}.`);
  }
  return readiness('unauthenticated', SIGN_IN_HINT);
}

/**
 * dsh-acp reports every tool call with kind `other` and the tool's name as
 * its title, so the item type comes from the name: its shell tools ran a
 * command, its file tools changed a file, its subagent tools delegated.
 */
export function dshItemType(toolCall: {
  title?: string | null;
}): 'command_execution' | 'file_change' | 'subagent' | undefined {
  switch (toolCall.title) {
    case 'bash':
    case 'pwsh':
      return 'command_execution';
    case 'write':
    case 'edit':
    case 'str_replace_editor':
      return 'file_change';
    case 'subagent':
    case 'subagent_fork':
      return 'subagent';
    default:
      return undefined;
  }
}

/**
 * DeepSeek Harness's automation-only ACP server, `dsh --profile acp`
 * (`@deepseek-ai/dsh-acp`). It advertises sessions, `session/resume`,
 * `session/close`, HTTP MCP and a `model` config option; it has no modes,
 * elicitation or vendor extensions, so the runtime mode is enforced on its
 * permission requests and questions are asked in prose.
 */
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
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--profile', 'acp'], env }),
  loginCommand: DSH_LOGIN,
  // The key, and the home holding dsh's profiles, saved key and sessions; a
  // session has to read the same home the sign-in check read.
  inheritEnv: [DSH_KEY, 'DSH_HOME'],
  // Booting the harness to ask it would load every plugin of the profile, and
  // its `authenticate` succeeds without checking anything, so the check reads
  // where dsh itself finds its key.
  checkSignIn: checkDshSignIn,
  itemType: dshItemType,
};

export function createDeepseekHarnessAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(deepseekHarnessAcp, options);
}
