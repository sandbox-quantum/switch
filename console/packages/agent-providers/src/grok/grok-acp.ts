import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED, type AcpToolCall } from '../acp/protocol';
import { readiness, signInWith } from '../readiness';

const GROK_LOGIN = 'grok login';

/**
 * The `authenticate` method a session starts with. Grok 1.0.77 refuses
 * `session/new` on an API key alone until `xai.api_key` is sent; an account
 * `grok login` saved needs no call. `grok.com` is never sent: it signs in.
 */
export function authMethod(env: Record<string, string | undefined>): string | undefined {
  return env.XAI_API_KEY?.trim() ? 'xai.api_key' : undefined;
}

/**
 * The MCP server of a tool call. Grok calls MCP tools through its `use_tool`
 * tool, naming them `<server>__<tool>` in `tool_name`; once running, the call
 * carries that name as its title.
 */
export function grokMcpServer(
  toolCall: AcpToolCall,
  servers: ReadonlySet<string>
): string | undefined {
  const input = toolCall.rawInput as { tool_name?: unknown } | undefined;
  const name = typeof input?.tool_name === 'string' ? input.tool_name : (toolCall.title ?? '');
  const bare = name.startsWith('mcp__') ? name.slice('mcp__'.length) : name;
  // Only a server this session registered: the longest whose name prefixes the
  // tool, so `a__b` and `a` stay apart. Any other name asks a person.
  return [...servers]
    .filter((server) => bare.startsWith(`${server}__`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * Whether a tool call is Grok's `spawn_subagent`. Grok names the tool in every
 * update's `_meta['x.ai/tool']`, while the title becomes the task's own
 * description once its input is in (1.0.77).
 */
function isSubagent(toolCall: AcpToolCall): boolean {
  const tool = toolCall._meta?.['x.ai/tool'] as { name?: unknown } | undefined;
  const input = toolCall.rawInput as { variant?: unknown } | undefined;
  return (
    tool?.name === 'spawn_subagent' ||
    toolCall.title === 'spawn_subagent' ||
    input?.variant === 'Task'
  );
}

/** Grok's `_x.ai/ask_user_question` request, which its `ask_user_question` tool sends. */
interface GrokQuestionRequest {
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean | null;
  }>;
}

/**
 * Asks the questions of Grok's `_x.ai/ask_user_question` in Switch. Grok 1.0.77
 * takes `{ outcome: 'accepted', answers }`, each question's text mapped to the
 * label chosen (several joined by ', '), or `{ outcome: 'cancelled' }`.
 */
export async function answerGrokQuestion(
  context: AcpSessionContext,
  params: unknown
): Promise<unknown> {
  const asked = ((params as GrokQuestionRequest).questions ?? []).map((q, index) => ({
    id: String(index),
    question: q.question ?? 'Choose an option.',
    options: (q.options ?? []).map((option) => ({
      label: option.label ?? '',
      value: option.label ?? '',
      ...(option.description ? { description: option.description } : {}),
    })),
    multiSelect: q.multiSelect === true,
    allowCustomAnswer: false,
  }));
  if (!asked.length) return { outcome: 'cancelled' };
  const result = await context.askQuestions(asked, (selected) => ({
    outcome: 'accepted',
    answers: Object.fromEntries(
      selected.map(({ questionId, values }) => [
        asked[Number(questionId)]!.question,
        values.join(', '),
      ])
    ),
  }));
  return result === ACP_CANCELLED ? { outcome: 'cancelled' } : result;
}

/** Grok Build's `grok agent stdio`, updates off as xAI advises for ACP. */
export const grokAcp: AcpProviderHooks = {
  provider: 'grok',
  label: 'Grok Build',
  defaultBinary: 'grok',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--no-auto-update', 'agent', 'stdio'],
    env,
  }),
  loginCommand: GROK_LOGIN,
  inheritEnv: ['XAI_API_KEY'],
  authMethodId: authMethod,
  // `authenticate` with `grok.com` runs the account sign-in, so it is never
  // asked. A key is taken as given, as Cursor's is; otherwise Grok offers
  // `cached_token` at `initialize` only when it holds an account sign-in.
  checkSignIn: async ({ env, handshake }) => {
    if (env.XAI_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the XAI_API_KEY it was given.');
    const { authMethods = [] } = await handshake();
    return authMethods.some((method) => method.id === 'cached_token')
      ? readiness('authenticated', 'Signed in to Grok Build.')
      : readiness(
          'unauthenticated',
          `${signInWith(GROK_LOGIN)} On a machine without a browser, run grok login --device-auth. Or set XAI_API_KEY to an API key from console.x.ai.`
        );
  },
  // Grok advertises no session modes: it asks before every tool, and full
  // access is the adapter approving each request. Its models are the `model`
  // config option a session carries (grok-4.6 and grok-4.5 on 1.0.77).
  mcpServerOf: grokMcpServer,
  // Declining a tool call makes Grok end its whole turn as `cancelled` (1.0.77).
  declineEndsTurn: true,
  itemType: (toolCall) => (isSubagent(toolCall) ? 'subagent' : undefined),
  extensions: (context, on) => {
    on.request('_x.ai/ask_user_question', (params) => answerGrokQuestion(context, params));
  },
};

export function createGrokAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokAcp, options);
}
