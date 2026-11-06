import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { RuntimeMode } from '../adapter';
import { optionalText } from '../host/provider-home';
import { loginWontHelp, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIMI_LOGIN = 'kimi login';

/**
 * Kimi's `yolo` ("Ask When Needed") runs routine work and still asks for risky commands,
 * sensitive files and questions, as Switch's auto mode means. Its `auto` ("Never Ask") is not
 * used: it refuses every question and skips the dangerous-command check, whatever its ACP label says.
 */
const KIMI_MODES: Record<RuntimeMode, string> = {
  'approval-required': 'default',
  'auto-accept-edits': 'default',
  auto: 'yolo',
  'full-access': 'yolo',
};

/** Kimi's subagent tools, by name or by the description it titles them with. */
const SUBAGENT_TITLE =
  /^(Agent|AgentSwarm)$|^Launching (background )?.+ agent: |^Launching agent swarm: /;

async function hasRefreshToken(path: string): Promise<boolean> {
  const text = await optionalText(path);
  try {
    const token = text === null ? undefined : (JSON.parse(text) as { refresh_token?: unknown });
    return typeof token?.refresh_token === 'string' && token.refresh_token !== '';
  } catch {
    return false;
  }
}

/**
 * Whether Kimi Code has a model it can sign in to, read from its files and
 * environment alone: it never runs `kimi`. A login on a plan without Kimi Code
 * still reads as signed in; only a prompt finds that out.
 */
export async function checkKimiSignIn(
  env: Readonly<Record<string, string | undefined>>
): Promise<ProviderReadiness> {
  if (env.KIMI_MODEL_NAME?.trim())
    return env.KIMI_MODEL_API_KEY?.trim()
      ? readiness('authenticated', 'Signs in with the KIMI_MODEL_API_KEY it was given.')
      : loginWontHelp(
          readiness('unauthenticated', 'KIMI_MODEL_NAME is set but KIMI_MODEL_API_KEY is missing.')
        );
  const signedOut = readiness('unauthenticated', signInWith(KIMI_LOGIN));
  const home = env.KIMI_CODE_HOME || join(homedir(), '.kimi-code');
  const text = await optionalText(join(home, 'config.toml'));
  if (text === null) return signedOut;
  let providers: Record<string, { api_key?: unknown; oauth?: { key?: unknown } }>;
  try {
    providers = (parse(text).providers ?? {}) as typeof providers;
  } catch {
    return readiness('unknown', "Could not read Kimi Code's config.toml.");
  }
  // shortcut: api_key_env is not detected; add it if users ask.
  for (const provider of Object.values(providers)) {
    if (typeof provider.api_key === 'string' && provider.api_key)
      return readiness('authenticated', 'Signed in.');
    const name = /^oauth\/([\w-]+)$/.exec(String(provider.oauth?.key ?? ''))?.[1];
    if (name && (await hasRefreshToken(join(home, 'credentials', `${name}.json`))))
      return readiness('authenticated', 'Signed in.');
  }
  return signedOut;
}

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
    // A session must not swap its own binary mid-run.
    env: { ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
    // `kimi acp` has no SIGTERM handler; only a closed input lets it finish saving the session.
    exitsOnClosedInput: true,
  }),
  loginCommand: KIMI_LOGIN,
  inheritEnv: [
    'KIMI_CODE_HOME',
    'KIMI_SHELL_PATH',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL',
  ],
  checkSignIn: ({ env }) => checkKimiSignIn(env),
  sessionMode: (runtimeMode, modes) => {
    const mode = KIMI_MODES[runtimeMode];
    return modes?.availableModes.some((offered) => offered.id === mode) ? mode : undefined;
  },
  mcpServerOf: (toolCall) => /^mcp__(.+?)__/.exec(toolCall.title ?? '')?.[1],
  itemType: (toolCall) => (SUBAGENT_TITLE.test(toolCall.title ?? '') ? 'subagent' : undefined),
  // Kimi asks its questions as permission requests, one option per choice.
  // shortcut: only one question per request (`q0_…`) has been seen; map `q1_…` when Kimi sends it.
  permission: (context, { toolCall, options }) => {
    if (toolCall.title !== 'AskUserQuestion') return undefined;
    return context.askQuestions(
      [
        {
          id: toolCall.toolCallId,
          question:
            toolCall.content?.find((part) => part.content?.text)?.content?.text ??
            'Choose an option.',
          options: options
            .filter((option) => option.kind === 'allow_once')
            .map((option) => ({ value: option.optionId, label: option.name })),
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
