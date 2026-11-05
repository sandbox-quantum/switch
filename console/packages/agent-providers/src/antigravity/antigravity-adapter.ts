import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSelectedAnswer } from '../acp/hooks';
import { ACP_CANCELLED, type AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { UserInputQuestion } from '../events';
import { readiness } from '../readiness';
import {
  AGY_LOGIN,
  ANTIGRAVITY_SIGN_IN,
  LEGACY_ANTIGRAVITY_SIGN_IN,
  antigravityLaunch,
  antigravityProfile,
  antigravitySignedIn,
  isLegacyAntigravityRuntime,
} from './runtime';

const SIGNED_OUT = /sign in|auth required|authentication required|unauthenticated|not logged in/i;

/**
 * The modes to try for each runtime mode, best first. `agy acp` offers
 * `default`, `accept-edits` and `plan`; the retired `antigravity-acp` offered
 * `auto_edit` and `yolo`. Full access needs no mode of its own: the adapter
 * approves every request a full-access session receives.
 */
const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['yolo', 'default'],
  'auto-accept-edits': ['auto_edit', 'accept-edits', 'default'],
  auto: ['auto_edit', 'accept-edits', 'default'],
  'approval-required': ['default'],
};

/** The session mode for `runtimeMode` among those the session advertised. */
export function antigravitySessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string {
  const preferences = MODE_PREFERENCES[runtimeMode];
  if (!modes?.availableModes.length) return preferences[0]!;
  return (
    preferences.find((id) => modes.availableModes.some((mode) => mode.id === id)) ??
    preferences.at(-1)!
  );
}

interface ElicitationChoice {
  const: string | number;
  title?: string;
}
interface ElicitationProperty {
  type?: string;
  title?: string;
  description?: string;
  enum?: Array<string | number>;
  oneOf?: ElicitationChoice[];
  anyOf?: ElicitationChoice[];
  items?: ElicitationProperty;
}
/** `elicitation/create`, which `agy acp` sends for its `ask_question` tool. */
export interface AcpElicitationRequest {
  sessionId?: string;
  toolCallId?: string;
  mode?: string;
  message?: string;
  requestedSchema?: { properties?: Record<string, ElicitationProperty> };
}

function choices(property: ElicitationProperty | undefined): UserInputQuestion['options'] {
  const offered = property?.oneOf ?? property?.anyOf;
  if (offered)
    return offered.map((choice) => ({
      value: String(choice.const),
      label: choice.title ?? String(choice.const),
    }));
  return (property?.enum ?? []).map((value) => ({ value: String(value), label: String(value) }));
}

/**
 * The questions a form elicitation asks: each field with offered answers, one
 * of them or (an array field) several. A free-text field, such as the
 * optional "Other" agy adds beside each question, is left unanswered.
 */
export function elicitationQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  if (request.mode !== undefined && request.mode !== 'form') return [];
  return Object.entries(request.requestedSchema?.properties ?? {}).flatMap(([id, property]) => {
    const multiSelect = property.type === 'array';
    const options = choices(multiSelect ? property.items : property);
    if (!options.length) return [];
    return [
      {
        id,
        question: property.title ?? property.description ?? request.message ?? 'Choose an option.',
        options,
        multiSelect,
        allowCustomAnswer: false,
      },
    ];
  });
}

/** The elicitation result for the answers chosen. */
export function elicitationAnswer(
  questions: UserInputQuestion[],
  selected: AcpSelectedAnswer[]
): { action: 'accept'; content: Record<string, string | string[]> } {
  return {
    action: 'accept',
    content: Object.fromEntries(
      selected.map(({ questionId, values }) => [
        questionId,
        questions.find((question) => question.id === questionId)?.multiSelect ? values : values[0]!,
      ])
    ),
  };
}

/**
 * Antigravity over ACP: Google's `agy acp`, or a legacy `antigravity-acp`
 * install. Questions arrive as permission requests.
 */
export const antigravityAcp: AcpProviderHooks = {
  provider: 'antigravity',
  label: 'Antigravity',
  defaultBinary: 'agy',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: antigravityLaunch,
  loginCommand: AGY_LOGIN,
  // A check must never sign in: `authenticate` with Google's methods opens a
  // browser. `agy` signs itself in from the user's keychain when it starts,
  // and refuses `session/list` with "Authentication required" when it could
  // not, so that request answers the question without changing anything.
  checkSignIn: async ({ binaryPath, env, handshake, request }) => {
    try {
      if (!isLegacyAntigravityRuntime(binaryPath)) {
        await handshake();
        const method = antigravityAcp.authMethodId?.(env, binaryPath);
        if (method) await request('authenticate', { methodId: method });
        await request('session/list', {});
        return readiness('authenticated', 'Signed in to Antigravity.');
      }
      // Antigravity ACP 1.3 lists every method whether or not one is in use,
      // so an outstanding method is only signed out when the profile holds no
      // token either.
      return !(await handshake()).authMethods?.length ||
        (await antigravitySignedIn(antigravityProfile(env)))
        ? readiness('authenticated', 'Signed in to Antigravity ACP.')
        : readiness('unauthenticated', LEGACY_ANTIGRAVITY_SIGN_IN);
    } catch (error) {
      if (SIGNED_OUT.test(String(error)))
        return readiness(
          'unauthenticated',
          isLegacyAntigravityRuntime(binaryPath) ? LEGACY_ANTIGRAVITY_SIGN_IN : ANTIGRAVITY_SIGN_IN
        );
      throw error;
    }
  },
  // `agy` needs no call when it signed itself in from the keychain; an API
  // key in the environment is only used once it is chosen. The legacy runtime
  // opens a browser when its profile holds no usable token, which is why only
  // a session start sends it.
  authMethodId: (env, binaryPath) =>
    isLegacyAntigravityRuntime(binaryPath)
      ? 'oauth-personal'
      : env.GEMINI_API_KEY
        ? 'gemini-api-key'
        : undefined,
  promptCapabilities: { image: true, audio: true, embeddedContext: true },
  // Antigravity has no reviewer of its own, so auto mode is its auto-edit
  // mode: edits run, commands and connector calls still ask.
  sessionMode: antigravitySessionMode,
  nativeSessionIdPrefix: {
    prefix: 'acp:',
    legacyMessage:
      'This conversation belongs to the previous Antigravity CLI runtime. Start a fresh ACP conversation; the existing transcript is preserved.',
  },
  mcpServerOf: (toolCall) => {
    const meta = toolCall._meta as
      | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
      | undefined;
    return meta?.is_mcp_tool_call === true && typeof meta.mcp?.server === 'string'
      ? meta.mcp.server
      : undefined;
  },
  // `agy acp` asks its questions as form elicitations when the client says
  // it can answer them; otherwise it ends the turn on an unanswered question.
  clientCapabilities: { elicitation: { form: {} } },
  extensions: (context, on) => {
    on.request('elicitation/create', async (params) => {
      const questions = elicitationQuestions(params as AcpElicitationRequest);
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        elicitationAnswer(questions, selected)
      );
      return result === ACP_CANCELLED ? { action: 'cancel' } : result;
    });
  },
  permission: (context, { toolCall, options }) => {
    if (!toolCall.toolCallId.startsWith('interaction_')) return undefined;
    if (!options.length) return Promise.resolve({ outcome: { outcome: 'cancelled' } });
    return context.askQuestions(
      [
        {
          id: toolCall.toolCallId,
          question: toolCall.title ?? 'Choose an option.',
          options: options.map((option) => ({ value: option.optionId, label: option.name })),
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
      ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
    );
  },
};

export function createAntigravityAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(antigravityAcp, options);
}
