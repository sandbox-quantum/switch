import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSelectedAnswer } from '../acp/hooks';
import { ACP_CANCELLED, type AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { UserInputQuestion } from '../events';
import { readiness, SIGNED_OUT_ERROR } from '../readiness';
import {
  AGY_LOGIN,
  ANTIGRAVITY_SIGN_IN,
  LEGACY_ANTIGRAVITY_SIGN_IN,
  antigravityLaunch,
  antigravityLoginCommand,
  antigravityProfile,
  antigravitySignedIn,
  isLegacyAntigravityRuntime,
} from './runtime';

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

/**
 * The session mode for `runtimeMode` among those the session advertised, or
 * none when it advertised none: the ids differ between runtimes, so one is
 * only sent when the session named it.
 */
export function antigravitySessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  const preferences = MODE_PREFERENCES[runtimeMode];
  if (!modes?.availableModes.length) return undefined;
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

type ElicitationValue = string | number | boolean;

/** The answers `property` offers, each with the value the schema takes for it. */
function choices(
  property: ElicitationProperty | undefined
): Array<{ value: ElicitationValue; label: string }> {
  const offered = property?.oneOf ?? property?.anyOf;
  if (offered)
    return offered.map((choice) => ({
      value: choice.const,
      label: choice.title ?? String(choice.const),
    }));
  if (property?.enum) return property.enum.map((value) => ({ value, label: String(value) }));
  if (property?.type === 'boolean')
    return [
      { value: true, label: 'Yes' },
      { value: false, label: 'No' },
    ];
  return [];
}

/** One question a form elicitation asks, and the fields its answer fills. */
interface ElicitationField {
  question: UserInputQuestion;
  /** Option value as offered to the user → the value the schema takes. */
  values: Map<string, ElicitationValue>;
  /** The field typed text goes into, if any: the question's own, or its "Other". */
  textField?: { id: string; property: ElicitationProperty };
}

/**
 * The questions a form elicitation asks. A field with offered answers is one
 * question, choosing one of them or (an array field) several; the free-text
 * "Other" agy adds beside it as `<field>_other` becomes that question's own
 * typed answer. Any other free-text field is a question answered by typing.
 */
function elicitationFields(request: AcpElicitationRequest): ElicitationField[] {
  if (request.mode !== undefined && request.mode !== 'form') return [];
  const properties = request.requestedSchema?.properties ?? {};
  const offeredBy = (property: ElicitationProperty) =>
    choices(property.type === 'array' ? property.items : property);
  const freeText = (property: ElicitationProperty | undefined): property is ElicitationProperty =>
    property !== undefined && !offeredBy(property).length;
  return Object.entries(properties).flatMap(([id, property]): ElicitationField[] => {
    const base = id.endsWith('_other') ? properties[id.slice(0, -'_other'.length)] : undefined;
    if (freeText(property) && base && !freeText(base)) return [];
    const offered = offeredBy(property);
    const other = properties[`${id}_other`];
    const textField = !offered.length
      ? { id, property }
      : freeText(other)
        ? { id: `${id}_other`, property: other }
        : undefined;
    return [
      {
        question: {
          id,
          question:
            property.title ?? property.description ?? request.message ?? 'Choose an option.',
          options: offered.map((choice) => ({ value: String(choice.value), label: choice.label })),
          multiSelect: property.type === 'array' && offered.length > 0,
          allowCustomAnswer: Boolean(textField),
        },
        values: new Map(offered.map((choice) => [String(choice.value), choice.value])),
        ...(textField ? { textField } : {}),
      },
    ];
  });
}

export function elicitationQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  return elicitationFields(request).map((field) => field.question);
}

/** Typed text as the schema of the field it fills takes it. */
function typedValue(
  text: string,
  property: ElicitationProperty
): ElicitationValue | ElicitationValue[] {
  if (property.type === 'array')
    return [typedValue(text, property.items ?? {}) as ElicitationValue];
  if (property.type === 'number' || property.type === 'integer') {
    const number = Number(text);
    // Text that is no number is passed as typed, for the agent to refuse.
    return text.trim() && Number.isFinite(number) ? number : text;
  }
  return text;
}

/** The elicitation result for the answers given. */
export function elicitationAnswer(
  request: AcpElicitationRequest,
  selected: AcpSelectedAnswer[]
): { action: 'accept'; content: Record<string, ElicitationValue | ElicitationValue[]> } {
  const fields = new Map(elicitationFields(request).map((field) => [field.question.id, field]));
  const content: Record<string, ElicitationValue | ElicitationValue[]> = {};
  for (const { questionId, values, custom } of selected) {
    const field = fields.get(questionId);
    if (!field) continue;
    const chosen = values.map((value) => field.values.get(value) ?? value);
    if (field.question.multiSelect) {
      if (chosen.length) content[questionId] = chosen;
    } else if (chosen.length) content[questionId] = chosen[0]!;
    if (custom !== undefined && field.textField)
      content[field.textField.id] = typedValue(custom, field.textField.property);
  }
  return { action: 'accept', content };
}

/** Whether a running agy answers as signed in, asked without signing it in. */
async function agySignedIn(
  request: <T>(method: string, params: unknown) => Promise<T>
): Promise<boolean> {
  try {
    await request('session/list', {});
    return true;
  } catch (error) {
    if (SIGNED_OUT_ERROR.test(String(error))) return false;
    throw error;
  }
}

/**
 * Antigravity over ACP: Google's `agy acp`, or a legacy `antigravity-acp`
 * install. agy asks its questions as form elicitations; the legacy runtime
 * asked them as permission requests.
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
  loginCommandFor: antigravityLoginCommand,
  // A check must never sign in, nor change how the CLI signs in: `authenticate`
  // with Google's methods opens a browser, and agy keeps the method it is
  // sent, so an API key chosen once would replace the user's Google sign-in.
  // agy signs itself in when it starts, and refuses `session/list` with
  // "Authentication required" when it could not.
  checkSignIn: async ({ binaryPath, env, handshake, request }) => {
    try {
      if (!isLegacyAntigravityRuntime(binaryPath)) {
        await handshake();
        if (await agySignedIn(request))
          return readiness('authenticated', 'Signed in to Antigravity.');
        return env.GEMINI_API_KEY
          ? readiness(
              'authenticated',
              'Antigravity is not signed in itself; sessions sign it in with GEMINI_API_KEY, which is checked when one starts.'
            )
          : readiness('unauthenticated', ANTIGRAVITY_SIGN_IN);
      }
      // Antigravity ACP 1.3 lists every method whether or not one is in use,
      // so an outstanding method is only signed out when the profile holds no
      // token either.
      return !(await handshake()).authMethods?.length ||
        (await antigravitySignedIn(antigravityProfile(env)))
        ? readiness('authenticated', 'Signed in to Antigravity ACP.')
        : readiness('unauthenticated', LEGACY_ANTIGRAVITY_SIGN_IN);
    } catch (error) {
      if (SIGNED_OUT_ERROR.test(String(error)))
        return readiness(
          'unauthenticated',
          isLegacyAntigravityRuntime(binaryPath) ? LEGACY_ANTIGRAVITY_SIGN_IN : ANTIGRAVITY_SIGN_IN
        );
      throw error;
    }
  },
  // The legacy runtime opens a browser when its profile holds no usable
  // token, which is why only a session start sends it. agy is sent the API key
  // method only when it could not sign itself in: see `checkSignIn`.
  authMethodId: (env, binaryPath) =>
    isLegacyAntigravityRuntime(binaryPath)
      ? 'oauth-personal'
      : env.GEMINI_API_KEY
        ? 'gemini-api-key'
        : undefined,
  alreadySignedIn: async ({ binaryPath, request }) =>
    !isLegacyAntigravityRuntime(binaryPath) && (await agySignedIn(request)),
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
      const request = params as AcpElicitationRequest;
      const questions = elicitationQuestions(request);
      // A form with no fields, or a mode other than a form (a URL to open).
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        elicitationAnswer(request, selected)
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
