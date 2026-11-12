import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import { ACP_CANCELLED, type AcpSessionModes, type AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { readiness, signInWith } from '../readiness';

export const GROK_BUILD_LOGIN = 'grok login';

const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['always-approve', 'default'],
  'auto-accept-edits': ['accept-edits', 'auto', 'default'],
  auto: ['auto', 'accept-edits', 'default'],
  'approval-required': ['ask', 'default'],
};

export function grokBuildSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  if (!modes?.availableModes.length) return undefined;
  const preferences = MODE_PREFERENCES[runtimeMode];
  return preferences.find((id) => modes.availableModes.some((mode) => mode.id === id));
}

/** Grok's `_x.ai/ask_user_question` request structure. */
interface GrokQuestionRequest {
  questions?: Array<{
    question?: string;
    options?: Array<{ label?: string; description?: string }>;
    multiSelect?: boolean | null;
  }>;
}

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

/** Grok Build's ACP stdio server. */
export const grokBuildAcp: AcpProviderHooks = {
  provider: 'grok-build',
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
  loginCommand: GROK_BUILD_LOGIN,
  inheritEnv: ['XAI_API_KEY'],
  authMethodId: (env) => (env.XAI_API_KEY?.trim() ? 'xai.api_key' : undefined),
  promptCapabilities: { image: true, embeddedContext: true },
  sessionMode: grokBuildSessionMode,
  mcpServerOf: (toolCall: AcpToolCall) => {
    const input = toolCall.rawInput as { tool_name?: unknown } | undefined;
    const name = typeof input?.tool_name === 'string' ? input.tool_name : (toolCall.title ?? '');
    return /^(?:mcp__)?([\w.-]+?)__\w/.exec(name)?.[1];
  },
  itemType: (toolCall: AcpToolCall) => {
    const input = toolCall.rawInput as { variant?: unknown } | undefined;
    return toolCall.title === 'spawn_subagent' || input?.variant === 'Task' ? 'subagent' : undefined;
  },
  extensions: (context, on) => {
    on.request('_x.ai/ask_user_question', (params) => answerGrokQuestion(context, params));
  },
  checkSignIn: async ({ handshake, env }) => {
    if (env.XAI_API_KEY?.trim())
      return readiness('authenticated', 'Signs in with the xAI API key it was given.');

    try {
      const result = await handshake();
      const authMethods = result.authMethods ?? [];
      if (authMethods.some((method) => method.id === 'cached_token'))
        return readiness('authenticated', 'Signed in to Grok Build.');
      if (authMethods.length) return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      return readiness('unknown', signInWith(GROK_BUILD_LOGIN));
    } catch (error) {
      if (
        /sign.?in|auth required|authentication required|unauthenticated|not logged in/i.test(
          String(error)
        )
      )
        return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      return readiness('unknown', 'Could not verify Grok Build authentication.');
    }
  },
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
