import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpPermissionRequest, AcpSessionResult, AcpToolCall } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { readiness, signInWith, type ProviderReadiness, type SignInCheckInput } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

// Running `qwen` in a terminal opens its "Connect a Provider" dialog when no
// provider is set up; `/auth` inside it changes one that is. Qwen Code 0.26
// has no sign-in subcommand (`qwen auth` was removed).
const QWEN_LOGIN = 'qwen';
const UNVERIFIED = 'Could not verify authentication. Check provider setup and try again.';
/** Qwen's answer to `session/new` when no provider is set up or its credentials fail. */
const AUTH_REQUIRED = /^Authentication required\b/i;
/** Qwen's persistent "always allow" options, which write a rule to its settings files. */
const PERSISTENT_OPTION_IDS = new Set(['proceed_always_project', 'proceed_always_user']);

/**
 * Reads what `session/new` answered: a session means a provider is set up and
 * its credentials load. Starting one runs no model call and stores nothing
 * until a prompt is sent.
 */
export function parseQwenSessionNew(answer: AcpSessionResult | Error): ProviderReadiness {
  if (answer instanceof Error) {
    if (!(answer instanceof JsonRpcError) || !AUTH_REQUIRED.test(answer.message))
      return readiness('unknown', UNVERIFIED);
    const reason = answer.message.match(/Authentication failed: (.+)$/i)?.[1]?.trim();
    return readiness(
      'unauthenticated',
      reason ? `${signInWith(QWEN_LOGIN)} Qwen Code said: ${reason}` : signInWith(QWEN_LOGIN)
    );
  }
  if (typeof answer?.sessionId !== 'string' || !answer.sessionId)
    return readiness('unknown', UNVERIFIED);
  const { currentModelId, availableModels } = answer.models ?? { availableModels: [] };
  const model = availableModels.find((choice) => choice.modelId === currentModelId)?.name;
  return readiness('authenticated', model ? `Signed in to Qwen Code (${model}).` : 'Signed in.');
}

/**
 * Qwen's `authMethods` are the same whether or not it is signed in, so the
 * check asks for a session instead. That loads the configured provider's
 * credentials without refreshing a Qwen OAuth sign-in (an expired one is
 * reported, not renewed), so it never opens a browser. `authenticate` is
 * never sent: in Qwen it clears the cached credentials first.
 */
async function checkQwenSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const client = new StdioJsonRpcClient({
    ...(await qwenAcp.launch(input)),
    cwd: input.cwd,
    logger: noopLogger,
    onExit: () => {},
  });
  const timer = setTimeout(() => {
    void client.dispose().catch(() => console.warn('Provider readiness process cleanup failed.'));
  }, 20000);
  try {
    await acpInitialize(client, qwenAcp);
    let answer: AcpSessionResult | Error;
    try {
      answer = await client.request<AcpSessionResult>('session/new', {
        cwd: input.cwd,
        mcpServers: [],
      });
    } catch (error) {
      answer = error instanceof Error ? error : new Error(String(error));
    }
    return parseQwenSessionNew(answer);
  } finally {
    clearTimeout(timer);
    await client.dispose();
  }
}

/** The MCP server a Qwen tool call belongs to, from its `_meta`. */
function qwenMcpServer(toolCall: AcpToolCall): string | undefined {
  const meta = toolCall._meta as
    | { provenance?: unknown; serverId?: unknown; toolName?: unknown }
    | undefined;
  if (meta?.provenance === 'mcp' && typeof meta.serverId === 'string' && meta.serverId)
    return meta.serverId;
  // A permission request names only the tool, `mcp__<server>__<tool>`, with
  // the server name's characters outside [A-Za-z0-9_-] replaced by `_`. A name
  // that changes that way does not match a registered server, so it asks.
  return typeof meta?.toolName === 'string' ? /^mcp__(.+?)__./.exec(meta.toolName)?.[1] : undefined;
}

interface QwenQuestion {
  question?: unknown;
  header?: unknown;
  options?: Array<{ label?: unknown; description?: unknown }>;
  multiSelect?: unknown;
}

/** Qwen's `ask_user_question`, which arrives as a permission request with the questions in `_meta`. */
function askUser(
  context: AcpSessionContext,
  { toolCall, options }: AcpPermissionRequest
): Promise<unknown> {
  const submit = options.find((option) => option.kind === 'allow_once');
  const raw = (toolCall._meta as { qwenQuestions?: unknown } | undefined)?.qwenQuestions;
  const asked = Array.isArray(raw) ? (raw as QwenQuestion[]) : [];
  const questions: UserInputQuestion[] = asked.map((q, index) => ({
    id: String(index),
    ...(typeof q.header === 'string' && q.header ? { header: q.header } : {}),
    question: typeof q.question === 'string' ? q.question : 'Choose an option.',
    options: (q.options ?? []).flatMap((option) =>
      typeof option.label === 'string'
        ? [
            {
              label: option.label,
              value: option.label,
              ...(typeof option.description === 'string'
                ? { description: option.description }
                : {}),
            },
          ]
        : []
    ),
    multiSelect: q.multiSelect === true,
    allowCustomAnswer: false,
  }));
  if (!submit || !questions.length || questions.some((q) => !q.options.length))
    return Promise.resolve({ outcome: { outcome: 'cancelled' } });
  // Qwen reads the answers beside the outcome, keyed by question index, each
  // the chosen labels as one string.
  return context.askQuestions(questions, (selected) => ({
    outcome: { outcome: 'selected', optionId: submit.optionId },
    answers: Object.fromEntries(
      selected.map(({ questionId, values }) => [questionId, values.join(', ')])
    ),
  }));
}

/** Qwen Code's `qwen --acp`, whose approval modes are permission levels. */
export const qwenAcp: AcpProviderHooks = {
  provider: 'qwen',
  label: 'Qwen Code',
  defaultBinary: 'qwen',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: QWEN_LOGIN,
  // Qwen reads its provider settings from QWEN_HOME (default ~/.qwen), and
  // its built-in providers each read their own key. The OpenAI, Anthropic,
  // Gemini, DashScope and Coding Plan keys are passed through already.
  inheritEnv: [
    'QWEN_HOME',
    'QWEN_MODEL',
    'GOOGLE_MODEL',
    'QWENCLOUD_API_KEY',
    'QWENCLOUD_TOKEN_PLAN_API_KEY',
    'BAILIAN_TOKEN_PLAN_API_KEY',
    'DEEPSEEK_API_KEY',
    'MINIMAX_API_KEY',
    'MODELSCOPE_API_KEY',
    'REQUESTY_API_KEY',
    'ZAI_API_KEY',
  ],
  checkSignIn: checkQwenSignIn,
  // No `authMethodId`: a session signs in with whatever provider Qwen is set
  // up with, and `authenticate` would replace that setup with an OpenAI key.
  // A new session starts in Qwen's `auto` mode, where its own classifier
  // approves actions without asking (QwenLM/qwen-code#11887), so every
  // runtime mode sets one explicitly. Auto mode keeps that classifier: what
  // it cannot clear still asks.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'yolo';
      case 'auto-accept-edits':
        return 'auto-edit';
      case 'auto':
        return 'auto';
      case 'approval-required':
        return 'default';
    }
  },
  mcpServerOf: qwenMcpServer,
  itemType: (toolCall) =>
    (toolCall._meta as { toolName?: unknown } | undefined)?.toolName === 'agent'
      ? 'subagent'
      : undefined,
  permission: (context, request) => {
    const meta = request.toolCall._meta as { qwenInteractionKind?: unknown } | undefined;
    if (meta?.qwenInteractionKind === 'user_question') return askUser(context, request);
    // Switch offers allow once, allow for this session and reject, never a
    // standing rule. Qwen's command and MCP "Always Allow in project / for
    // user" would write one to its settings, so they are not offered; its
    // "Allow All Edits" lasts for the session and stays.
    request.options = request.options.filter(
      (option) => !PERSISTENT_OPTION_IDS.has(option.optionId)
    );
    return undefined;
  },
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
