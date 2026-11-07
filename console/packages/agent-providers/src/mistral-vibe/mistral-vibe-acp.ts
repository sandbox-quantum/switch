import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSelectedAnswer } from '../acp/hooks';
import { ACP_CANCELLED, type AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { UserInputQuestion } from '../events';
import { readiness, signInWith } from '../readiness';

export const VIBE_LOGIN = 'vibe --setup';

/**
 * The modes to try for each runtime mode, best first. `vibe-acp` 3.1 offers
 * `ask`, `accept-edits` (its default) and `auto-approve`; `smart-approve`, its
 * classifier, is offered only where Vibe enables it, so auto mode falls back
 * to accepting edits, and commands still ask. A mode the session did not
 * advertise is still sent as the last choice, so a session Vibe cannot put in
 * the asked-for mode fails to start rather than running in its default.
 */
const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['auto-approve'],
  'auto-accept-edits': ['accept-edits'],
  auto: ['smart-approve', 'accept-edits'],
  'approval-required': ['ask'],
};

export function vibeSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string {
  const preferences = MODE_PREFERENCES[runtimeMode];
  return (
    preferences.find((id) => modes?.availableModes.some((mode) => mode.id === id)) ??
    preferences.at(-1)!
  );
}

interface VibeChoice {
  const: string;
  title?: string;
}
interface VibeQuestionProperty {
  type?: string;
  /** The question's short header, when it has one. */
  title?: string;
  /** The question itself. */
  description?: string;
  oneOf?: VibeChoice[];
  items?: { anyOf?: VibeChoice[] };
}
/** `elicitation/create`, which `vibe-acp` sends for its `ask_user_question` tool. */
export interface VibeElicitationRequest {
  mode?: string;
  message?: string;
  requestedSchema?: { properties?: Record<string, VibeQuestionProperty> };
}

/**
 * The questions a Vibe form asks: one per property, header in `title`, the
 * question in `description`, options as `oneOf` (or `items.anyOf` for several
 * answers). Vibe takes any answer text, so every question allows typing one.
 */
export function vibeQuestions(request: VibeElicitationRequest): UserInputQuestion[] {
  if (request.mode !== undefined && request.mode !== 'form') return [];
  return Object.entries(request.requestedSchema?.properties ?? {}).map(([id, property]) => {
    const multiSelect = property.type === 'array';
    const offered = (multiSelect ? property.items?.anyOf : property.oneOf) ?? [];
    return {
      id,
      ...(property.title ? { header: property.title } : {}),
      question: property.description ?? property.title ?? request.message ?? 'Choose an option.',
      options: offered.map((choice) => ({
        value: choice.const,
        label: choice.title ?? choice.const,
      })),
      multiSelect,
      allowCustomAnswer: true,
    };
  });
}

/** The elicitation result for the answers given, as Vibe reads it back. */
export function vibeAnswer(
  request: VibeElicitationRequest,
  selected: AcpSelectedAnswer[]
): { action: 'accept'; content: Record<string, string | string[]> } {
  const questions = new Map(vibeQuestions(request).map((question) => [question.id, question]));
  const content: Record<string, string | string[]> = {};
  for (const { questionId, values, custom } of selected) {
    const question = questions.get(questionId);
    if (!question) continue;
    const answers = custom === undefined ? values : [...values, custom];
    if (question.multiSelect) content[questionId] = answers;
    else if (answers.length) content[questionId] = answers[0]!;
  }
  return { action: 'accept', content };
}

/**
 * Mistral Vibe's `vibe-acp`. It signs in with `MISTRAL_API_KEY` or the key
 * `vibe --setup` saves, which it reads itself at session start, so a session
 * sends no `authenticate`: Vibe's only method opens a browser.
 */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: [], env }),
  loginCommand: VIBE_LOGIN,
  // Where Vibe keeps its config, saved key file and sessions; a session has
  // to read the same home the sign-in check read.
  inheritEnv: ['VIBE_HOME'],
  // `_auth/status` reports whether the active provider has a key (session,
  // environment, `.env` or keyring) without signing in or spending a request,
  // so a key it reports is not proven valid until a turn runs.
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    const status = await request<{ authenticated?: unknown }>('_auth/status', {});
    return status.authenticated === true
      ? readiness('authenticated', 'Signed in.')
      : readiness('unauthenticated', signInWith(VIBE_LOGIN));
  },
  sessionMode: vibeSessionMode,
  // vibe-acp 3.1 names a tool from a registered MCP server
  // `mcp_<server>.<tool>` in `_meta.tool_name`, and its permission request
  // carries only the tool call id. Without this, the session's own Switch
  // tools stop for an approval in ask mode.
  mcpServerOf: (toolCall) => {
    const name = (toolCall._meta as { tool_name?: unknown } | undefined)?.tool_name;
    const match = typeof name === 'string' ? /^mcp_(.+)\.[^.]+$/.exec(name) : null;
    return match?.[1];
  },
  // A spawned child agent (`agents.spawn`) is marked `effect_kind: subagent`.
  itemType: (toolCall) =>
    (toolCall._meta as { effect_kind?: unknown } | undefined)?.effect_kind === 'subagent'
      ? 'subagent'
      : undefined,
  // vibe-acp 3.1 registers HTTP MCP servers from `session/new` (as
  // streamable HTTP) but does not declare `mcpCapabilities.http`.
  mcpCapabilities: { http: true },
  // Vibe offers `ask_user_question` only to a client that answers form
  // elicitations; otherwise the tool is disabled.
  clientCapabilities: { elicitation: { form: {} } },
  extensions: (context, on) => {
    on.request('elicitation/create', async (params) => {
      const request = params as VibeElicitationRequest;
      const questions = vibeQuestions(request);
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        vibeAnswer(request, selected)
      );
      return result === ACP_CANCELLED ? { action: 'cancel' } : result;
    });
  },
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
