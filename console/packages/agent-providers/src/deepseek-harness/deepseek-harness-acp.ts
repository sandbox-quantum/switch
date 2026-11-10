import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { parseDocument } from 'yaml';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

/**
 * DeepSeek Harness has no login command: its Web app's Models page saves the
 * key to `$DSH_HOME/.credentials.yaml`, or a provider API key is exported.
 */
export const DSH_LOGIN = 'dsh web';
export const DSH_KEY = 'DEEPSEEK_API_KEY';
export const DSH_OPENROUTER_KEY = 'OPENROUTER_API_KEY';
const DSH_KEYS = [DSH_KEY, DSH_OPENROUTER_KEY] as const;
type DshKey = (typeof DSH_KEYS)[number];

const SIGN_IN_HINT = `${signInWith(DSH_LOGIN)} Configure a model provider and save its key on the Models page, or set ${DSH_KEY} or ${DSH_OPENROUTER_KEY}.`;

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

/** Whether the credential store contains a non-empty string at `refs[key]`.
 * An invalid or ambiguous document returns undefined, never a false login result.
 */
export function credentialsHaveKey(text: string, key: DshKey = DSH_KEY): boolean | undefined {
  try {
    const document = parseDocument(text, { uniqueKeys: true });
    if (document.errors.length) return undefined;
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (value == null) return false;
    if (typeof value !== 'object' || Array.isArray(value)) return undefined;
    const refs: unknown = (value as Record<string, unknown>).refs;
    if (refs == null) return false;
    if (typeof refs !== 'object' || Array.isArray(refs)) return undefined;
    const credential = (refs as Record<string, unknown>)[key];
    return typeof credential === 'string' && credential.trim() !== '';
  } catch {
    return undefined;
  }
}

/** Whether a dotenv file sets the named non-empty key. */
export function dotenvHasKey(text: string, key: DshKey = DSH_KEY): boolean {
  return !!parseEnv(text)[key]?.trim();
}

/**
 * Detect known provider keys without starting dsh. Key presence does not
 * establish that the provider route is configured or the key is valid.
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
  const files = [join(isAbsolute(cwd) ? cwd : resolve(cwd), '.env'), join(home, '.env')];
  const savedOpenRouter =
    credentials === undefined ? false : credentialsHaveKey(credentials, DSH_OPENROUTER_KEY);
  const savedDeepSeek = credentials === undefined ? false : credentialsHaveKey(credentials);

  // An OpenRouter key can belong to another app or an unselected route, even
  // if a DeepSeek key is present. We cannot know the active route without dsh.
  const openRouterHint = `Found ${DSH_OPENROUTER_KEY}; configure and select an OpenRouter model in the dsh ACP profile. The route and key have not been verified.`;
  if (savedOpenRouter) return readiness('unknown', openRouterHint);
  if (env[DSH_OPENROUTER_KEY]?.trim()) return readiness('unknown', openRouterHint);
  for (const file of files) {
    const text = await readText(file);
    if (text !== undefined && dotenvHasKey(text, DSH_OPENROUTER_KEY))
      return readiness('unknown', openRouterHint);
  }

  if (savedOpenRouter === undefined || savedDeepSeek === undefined)
    return readiness(
      'unknown',
      'Could not parse the DeepSeek Harness credential store. Check the provider setup and retry.'
    );

  // Keep the legacy DeepSeek-only check when no OpenRouter key is present.
  if (savedDeepSeek)
    return readiness('authenticated', 'Signed in with the DeepSeek key saved in DeepSeek Harness.');
  if (env[DSH_KEY]?.trim())
    return readiness('authenticated', `Signs in with the ${DSH_KEY} it was given.`);
  for (const file of files) {
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
