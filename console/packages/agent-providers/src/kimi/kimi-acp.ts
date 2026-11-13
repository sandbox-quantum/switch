import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const KIMI_LOGIN = 'kimi login';

/**
 * Kimi Code checks for updates before it starts, which can prompt; a session
 * host has nobody to answer, so the check is switched off for the processes
 * Switch starts.
 */
const NO_AUTO_UPDATE = { KIMI_CODE_NO_AUTO_UPDATE: '1' };

/** Where `kimi` keeps its config and sign-ins: `KIMI_CODE_HOME`, else `~/.kimi-code`. */
export function kimiHome(env: Record<string, string>): string {
  const custom = env.KIMI_CODE_HOME?.trim();
  if (custom) return custom;
  return join(env.HOME?.trim() || env.USERPROFILE?.trim() || homedir(), '.kimi-code');
}

/** One `[providers.<id>]` entry, as `kimi provider list --json` prints it. */
interface KimiProvider {
  type?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  env?: Record<string, unknown>;
}

const filled = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `kimi provider list --json`. `kimi login` writes a managed provider
 * (`managed:kimi-code`) whose token lives in `credentials/kimi-code.json`, and
 * logging out deletes that file but keeps the provider, so a managed provider
 * counts only while its credential file is there. A provider configured with
 * an API key, in `config.toml` or through `api_key_env`, is taken as given: a
 * key cannot be checked without spending a request, and a bad one fails the
 * first turn.
 */
export async function parseKimiProviders(
  output: string,
  env: Record<string, string>
): Promise<ProviderReadiness> {
  let providers: Record<string, KimiProvider>;
  try {
    const parsed = JSON.parse(output) as { providers?: unknown };
    if (!parsed.providers || typeof parsed.providers !== 'object') throw new Error('no providers');
    providers = parsed.providers as Record<string, KimiProvider>;
  } catch {
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  }
  const home = kimiHome(env);
  let unverifiable = false;
  for (const [id, provider] of Object.entries(providers)) {
    if (id.startsWith('managed:')) {
      const name = id.slice('managed:'.length);
      if (name && (await exists(join(home, 'credentials', `${name}.json`))))
        return readiness('authenticated', 'Signed in to Kimi Code.');
      continue;
    }
    if (filled(provider.apiKey))
      return readiness('authenticated', `Signs in with the API key configured for ${id}.`);
    if (filled(provider.apiKeyEnv) && filled(env[provider.apiKeyEnv!]))
      return readiness('authenticated', `Signs in with ${provider.apiKeyEnv} for ${id}.`);
    if (
      Object.entries(provider.env ?? {}).some(
        ([key, value]) => /_API_KEY$/.test(key) && filled(value)
      )
    )
      return readiness('authenticated', `Signs in with the API key configured for ${id}.`);
    // A provider with no key we can see (Google application default
    // credentials, say) may still work.
    unverifiable = true;
  }
  return unverifiable
    ? readiness('unknown', 'Kimi Code has a provider configured but no key this check can see.')
    : readiness('unauthenticated', signInWith(KIMI_LOGIN));
}

/** Kimi's AskUserQuestion, sent as a permission request when the client has no forms. */
const QUESTION_OPTION = /^q\d+_(?:opt_\d+|skip)$/;
const SKIP_OPTION = /^q\d+_skip$/;

/**
 * The server a tool call belongs to. Kimi names MCP tools
 * `mcp__<server>__<tool>`, with runs of underscores folded to one inside each
 * part. A session server is matched by its folded name, so one with `__` in
 * its name is still found; any other server is read from the name, where the
 * first `__` after the prefix ends it.
 */
export function kimiMcpServer(
  toolCall: AcpToolCall,
  servers: ReadonlySet<string> = new Set()
): string | undefined {
  const title = toolCall.title ?? '';
  const session = [...servers].find((name) =>
    title.startsWith(`mcp__${name.replace(/_+/g, '_')}__`)
  );
  return session ?? title.match(/^mcp__(.+?)__/)?.[1];
}

/** Kimi's `Agent` and `AgentSwarm` tools, titled by name while streaming, then by their launch line. */
function isSubagent(toolCall: AcpToolCall): boolean {
  const title = toolCall.title ?? '';
  if (title === 'Agent' || title === 'AgentSwarm') return true;
  if (/^Launching (?:background )?\S+ agent: /.test(title)) return true;
  const input = toolCall.rawInput;
  return (
    typeof input?.prompt === 'string' &&
    typeof input?.description === 'string' &&
    ('subagent_type' in input || 'run_in_background' in input)
  );
}

/** Kimi Code's `kimi acp`. */
export const kimiAcp: AcpProviderHooks = {
  provider: 'kimi',
  label: 'Kimi Code',
  defaultBinary: 'kimi',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env: { ...env, ...NO_AUTO_UPDATE },
  }),
  loginCommand: KIMI_LOGIN,
  // Kimi reads keys from its config file, not the shell. These are the
  // exceptions: its data directory, a model defined entirely from the
  // environment, and the Git Bash it runs commands in on Windows.
  inheritEnv: [
    'KIMI_CODE_HOME',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL',
    'KIMI_SHELL_PATH',
  ],
  // `initialize` lists `login` whether or not a token is in place, and
  // `authenticate` is the sign-in itself, so the check reads the configured
  // providers instead. It never starts a login.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (filled(env.KIMI_MODEL_NAME) && filled(env.KIMI_MODEL_API_KEY))
      return readiness('authenticated', 'Uses the model defined by KIMI_MODEL_NAME and its key.');
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['provider', 'list', '--json'], {
          cwd,
          env: { ...env, ...NO_AUTO_UPDATE },
          timeout: 15000,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseKimiProviders(output, env);
  },
  // Kimi's own modes are permission levels. Ask When Needed (its `yolo`) runs
  // routine edits and commands and asks before sensitive ones, which is what
  // auto mode means here; full access is the same mode with every remaining
  // request allowed by the adapter. Never Ask (its `auto`) would also stop the
  // agent asking the room questions, which full access still allows.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
      case 'auto':
        return 'yolo';
      case 'auto-accept-edits':
      case 'approval-required':
        return 'default';
    }
  },
  mcpServerOf: kimiMcpServer,
  itemType: (toolCall) => (isSubagent(toolCall) ? 'subagent' : undefined),
  permission: (context, { toolCall, options }) => {
    if (!options.length || !options.every((o) => QUESTION_OPTION.test(o.optionId)))
      return undefined;
    const choices = options.filter((o) => !SKIP_OPTION.test(o.optionId));
    if (!choices.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    const question =
      (Array.isArray(toolCall.content) ? toolCall.content : [])
        .map((part) => part.content?.text ?? '')
        .find((text) => text.trim()) ??
      toolCall.title ??
      'Choose an option.';
    return context.askQuestions(
      [
        {
          id: toolCall.toolCallId,
          question,
          options: choices.map((o) => ({ value: o.optionId, label: o.name })),
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
      ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
    );
  },
};

export function createKimiAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kimiAcp, options);
}
