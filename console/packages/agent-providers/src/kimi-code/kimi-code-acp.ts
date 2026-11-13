import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import {
  elicitationAnswer,
  elicitationQuestions,
  FORM_ELICITATION_CAPABILITIES,
  type AcpElicitationRequest,
} from '../acp/elicitation';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ACP_CANCELLED } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { execProvider } from '../provider-process';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';

const KIMI_CODE_LOGIN = 'kimi login';
/**
 * A native install of Kimi swaps in an update it has staged, and relaunches
 * itself, whenever it starts. The processes Switch starts leave that to the
 * person's own runs of `kimi`.
 */
const NO_AUTO_UPDATE = { KIMI_CODE_NO_AUTO_UPDATE: '1' };
/** The option ids Kimi gives a question it asks as a permission request. */
const QUESTION_OPTION = /^q\d+_(?:opt_\d+|skip)$/;
/** The Agent and AgentSwarm tools, by name or by the title Kimi gives a call to them. */
const SUBAGENT_TITLE =
  /^(?:Agent|AgentSwarm)$|^Launching (?:background )?(?:\S+ agent|agent swarm): /;

/** A credential as `kimi provider list --json` prints it, on a provider or on a model. */
const credentialSchema = z.object({
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  env: z.record(z.string(), z.unknown()).optional(),
  oauth: z.object({ key: z.string() }).optional(),
});
type KimiCredential = z.infer<typeof credentialSchema>;
const providerListSchema = z.object({
  providers: z.record(z.string(), credentialSchema),
  models: z.record(z.string(), credentialSchema),
});

/**
 * Whether Kimi Code can sign a session in, from the providers and models
 * `kimi provider list --json` prints: one with an API key in its config, in
 * the variable its `api_key_env` names or in a `*_API_KEY` entry of its `env`
 * table, or with the OAuth token file `kimi login` writes and `kimi logout`
 * deletes. They come from Kimi's own config loader, so `KIMI_MODEL_*` count
 * as they do for a session. The command writes an empty `config.toml` in
 * Kimi's home when there is none.
 */
async function checkKimiCodeSignIn({
  binaryPath,
  cwd,
  env,
}: SignInCheckInput): Promise<ProviderReadiness> {
  let output: unknown;
  try {
    const { stdout } = await execProvider(binaryPath, ['provider', 'list', '--json'], {
      cwd,
      env: { ...env, ...NO_AUTO_UPDATE },
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    output = JSON.parse(stdout);
  } catch (error) {
    const { stderr, message } = error as { stderr?: string; message?: string };
    return readiness('unknown', `kimi provider list failed: ${stderr?.trim() || message}`);
  }
  const listed = providerListSchema.safeParse(output);
  if (!listed.success)
    return readiness('unknown', 'kimi provider list printed no providers this check can read.');
  const home = env.KIMI_CODE_HOME || join(env.HOME || homedir(), '.kimi-code');
  const filled = (value: unknown) => typeof value === 'string' && value.trim() !== '';
  const signsIn = ({ apiKey, apiKeyEnv, env: table = {}, oauth }: KimiCredential) =>
    filled(apiKey) ||
    (apiKeyEnv !== undefined && filled(env[apiKeyEnv])) ||
    Object.entries(table).some(([name, value]) => name.endsWith('_API_KEY') && filled(value)) ||
    (oauth !== undefined &&
      existsSync(join(home, 'credentials', `${oauth.key.replace(/^oauth\//, '')}.json`)));
  const { providers, models } = listed.data;
  return [...Object.values(providers), ...Object.values(models)].some(signsIn)
    ? readiness('authenticated', 'Kimi Code has a provider it can sign in with.')
    : readiness(
        'unauthenticated',
        `${signInWith(KIMI_CODE_LOGIN)} Or set KIMI_MODEL_NAME and KIMI_MODEL_API_KEY to use a model of another provider.`
      );
}

/**
 * The questions of Kimi's form. It titles each field with the question's
 * short header where the model gave one, and puts the questions themselves
 * in the form's message, one a line, so each is asked by its own text with
 * its header beside it.
 */
export function kimiCodeQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  const questions = elicitationQuestions(request);
  const lines = request.message?.split('\n') ?? [];
  // Where a question breaks lines itself, the lines can't be told apart.
  const texts =
    lines.length === questions.length ? lines : questions.length === 1 ? [request.message] : [];
  return questions.map((question, index) => {
    const header = request.requestedSchema?.properties?.[question.id]?.title?.trim() || undefined;
    const text = texts[index]?.trim() || header || 'Choose an option.';
    return { ...question, question: text, ...(header && header !== text ? { header } : {}) };
  });
}

/** Kimi Code's `kimi acp`. */
export const kimiCodeAcp: AcpProviderHooks = {
  provider: 'kimi-code',
  label: 'Kimi Code',
  defaultBinary: 'kimi',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // A SIGTERM ends Kimi before it has saved the last turn of a conversation,
  // which a resumed session then lacks.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env: { ...env, ...NO_AUTO_UPDATE },
    exitsOnClosedInput: true,
  }),
  loginCommand: KIMI_CODE_LOGIN,
  // Its data directory, the Git Bash it runs commands with on Windows, and
  // the variables that give it a model of another provider without a config
  // file.
  inheritEnv: [
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
  ],
  // `initialize` offers its `login` method whether or not Kimi is signed in.
  checkSignIn: checkKimiCodeSignIn,
  // Kimi's modes are permission levels. `yolo` asks only before dangerous
  // commands and access to sensitive files or git internals, which is auto
  // mode, and full access answers those itself. Kimi's `auto` never asks, and
  // so refuses the agent's questions too.
  sessionMode: (runtimeMode) =>
    runtimeMode === 'auto' || runtimeMode === 'full-access' ? 'yolo' : 'default',
  // Kimi names an MCP tool `mcp__<server>__<tool>`, in each part replacing
  // characters other than letters, digits, `_` and `-` by `_` and runs of `_`
  // by one, so the first `__` ends the server's name. It titles a permission
  // request with the name of the tool.
  mcpServerOf: (toolCall) => /^mcp__(.+?)__/.exec(toolCall.title ?? '')?.[1],
  itemType: (toolCall) => (SUBAGENT_TITLE.test(toolCall.title ?? '') ? 'subagent' : undefined),
  // Kimi asks its questions as a form when the client says it can answer one:
  // all of them at once, with several choices where a question takes them.
  clientCapabilities: FORM_ELICITATION_CAPABILITIES,
  extensions: (context, on) => {
    on.request('elicitation/create', async (params) => {
      const request = params as AcpElicitationRequest;
      const questions = kimiCodeQuestions(request);
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        elicitationAnswer(request, selected)
      );
      return result === ACP_CANCELLED ? { action: 'cancel' } : result;
    });
  },
  // Where a form fails, Kimi asks the first question alone as a permission
  // request.
  permission: (context, { toolCall, options }) => {
    if (!options.length || !options.every((option) => QUESTION_OPTION.test(option.optionId)))
      return undefined;
    return context.askQuestions(
      [
        {
          id: toolCall.toolCallId,
          question:
            toolCall.content?.find((part) => part.content?.text)?.content?.text ??
            'Choose an option.',
          options: options.map((option) => ({ value: option.optionId, label: option.name })),
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
      ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
    );
  },
};

export function createKimiCodeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kimiCodeAcp, options);
}
