import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ACP_CANCELLED } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import {
  elicitationAnswer,
  elicitationQuestions,
  type AcpElicitationRequest,
} from '../antigravity/antigravity-adapter';
import type { UserInputQuestion } from '../events';
import { AGENT_ENV_VARS } from '../host/agent-env-vars';
import { optionalText } from '../host/provider-home';
import { loginWontHelp, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIMI_LOGIN = 'kimi login';

/** What Kimi reads to find its home and shell, and the `KIMI_MODEL_*` model it can run on instead. */
const KIMI_ENV = [
  'KIMI_CODE_HOME',
  'KIMI_SHELL_PATH',
  'KIMI_MODEL_NAME',
  'KIMI_MODEL_API_KEY',
  'KIMI_MODEL_PROVIDER_TYPE',
  'KIMI_MODEL_BASE_URL',
  'KIMI_MODEL_CAPABILITIES',
  'KIMI_MODEL_MAX_CONTEXT_SIZE',
  'KIMI_MODEL_MAX_OUTPUT_SIZE',
  'KIMI_MODEL_DISPLAY_NAME',
  'KIMI_MODEL_REASONING_KEY',
  'KIMI_MODEL_ADAPTIVE_THINKING',
  'KIMI_MODEL_THINKING_EFFORT',
];

/** Variables a session host passes to Kimi; any other is unset in its sessions. */
const PASSED_TO_SESSIONS = new Set<string>([...AGENT_ENV_VARS, ...KIMI_ENV]);

interface KimiProvider {
  api_key?: unknown;
  api_key_env?: unknown;
  env?: unknown;
  oauth?: { key?: unknown };
}

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

/**
 * A form's questions by their full text. Kimi titles each field with the
 * question's short header and puts the questions in `message`, one per line.
 */
function kimiFormQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  const questions = elicitationQuestions(request);
  const lines = request.message?.split('\n') ?? [];
  if (lines.length !== questions.length) return questions;
  return questions.map((question, i) => ({
    ...question,
    question: lines[i]!.trim() || question.question,
  }));
}

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
  let providers: Record<string, KimiProvider>;
  try {
    providers = (parse(text).providers ?? {}) as typeof providers;
  } catch {
    return readiness('unknown', "Could not read Kimi Code's config.toml.");
  }
  let keyEnvProblem: string | undefined;
  for (const provider of Object.values(providers)) {
    if (typeof provider.api_key === 'string' && provider.api_key)
      return readiness('authenticated', 'Signed in.');
    // A provider with `api_key_env` takes its key from that variable and nowhere else.
    if (typeof provider.api_key_env === 'string' && provider.api_key_env) {
      const name = provider.api_key_env;
      if (!env[name]?.trim())
        keyEnvProblem ??= `config.toml reads the API key from ${name}, which is not set.`;
      else if (!PASSED_TO_SESSIONS.has(name))
        keyEnvProblem ??= `config.toml reads the API key from ${name}, which Switch does not pass to sessions. Use one it passes, such as KIMI_API_KEY.`;
      else return readiness('authenticated', `Signs in with the ${name} it was given.`);
      continue;
    }
    const table = typeof provider.env === 'object' && provider.env ? provider.env : {};
    if (Object.entries(table).some(([key, value]) => key.endsWith('_API_KEY') && value))
      return readiness('authenticated', 'Signed in.');
    const name = /^oauth\/([\w-]+)$/.exec(String(provider.oauth?.key ?? ''))?.[1];
    if (name && (await hasRefreshToken(join(home, 'credentials', `${name}.json`))))
      return readiness('authenticated', 'Signed in.');
  }
  return keyEnvProblem ? loginWontHelp(readiness('unauthenticated', keyEnvProblem)) : signedOut;
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
  inheritEnv: KIMI_ENV,
  checkSignIn: ({ env }) => checkKimiSignIn(env),
  sessionMode: (runtimeMode, modes) => {
    const mode = KIMI_MODES[runtimeMode];
    return modes?.availableModes.some((offered) => offered.id === mode) ? mode : undefined;
  },
  mcpServerOf: (toolCall) => /^mcp__(.+?)__/.exec(toolCall.title ?? '')?.[1],
  itemType: (toolCall) => (SUBAGENT_TITLE.test(toolCall.title ?? '') ? 'subagent' : undefined),
  // Kimi asks every question in one form when the client can answer forms.
  clientCapabilities: { elicitation: { form: {} } },
  extensions: (context, on) => {
    on.request('elicitation/create', async (params) => {
      const request = params as AcpElicitationRequest;
      const questions = kimiFormQuestions(request);
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        elicitationAnswer(request, selected)
      );
      return result === ACP_CANCELLED ? { action: 'cancel' } : result;
    });
  },
  // Kimi's fallback when a form fails: a permission request carrying only the first
  // question (`q0_…`), one option per choice.
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
