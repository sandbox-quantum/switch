import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import { answerFormElicitations, FORM_ELICITATION_CAPABILITIES } from '../acp/elicitation';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpSessionModes } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
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
 * `default`, `accept-edits`, `auto` and `plan`; the retired `antigravity-acp`
 * offered `auto_edit` and `yolo`. Full access needs no mode of its own: the
 * adapter approves every request a full-access session receives.
 */
const MODE_PREFERENCES: Record<RuntimeMode, readonly string[]> = {
  'full-access': ['yolo', 'default'],
  'auto-accept-edits': ['auto_edit', 'accept-edits', 'default'],
  auto: ['auto', 'auto_edit', 'accept-edits', 'default'],
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
    steering: true,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // `agy acp` steers a running turn when sent another prompt (agy 1.5.0's
  // changelog; measured on 1.5.17). The retired `antigravity-acp` is not
  // known to, so its sessions queue.
  steersRunningTurn: (binaryPath) => !isLegacyAntigravityRuntime(binaryPath),
  launch: antigravityLaunch,
  loginCommand: AGY_LOGIN,
  loginCommandFor: antigravityLoginCommand,
  // agy 1.5 connects to HTTP MCP servers, headers included, without declaring
  // `mcpCapabilities.http`.
  mcpCapabilities: { http: true },
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
  // agy's own Auto mode is used where offered, falling back to auto-edit on
  // older runtimes.
  sessionMode: antigravitySessionMode,
  nativeSessionIdPrefix: {
    prefix: 'acp:',
    legacyMessage:
      'This conversation belongs to the previous Antigravity CLI runtime. Start a fresh ACP conversation; the existing transcript is preserved.',
  },
  mcpServerOf: (toolCall, servers) => {
    const meta = toolCall._meta as
      | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
      | undefined;
    if (meta?.is_mcp_tool_call === true && typeof meta.mcp?.server === 'string')
      return meta.mcp.server;
    // agy 1.5 sends no `_meta`, only the tool as `mcp_<server>_<tool>`; the
    // longest registered server wins, since server names may hold `_`.
    const name = (toolCall as { name?: unknown }).name;
    if (typeof name !== 'string') return undefined;
    return [...servers]
      .filter((server) => name.startsWith(`mcp_${server}_`))
      .sort((a, b) => b.length - a.length)[0];
  },
  // `agy acp` asks its questions as form elicitations when the client says
  // it can answer them; otherwise it ends the turn on an unanswered question.
  clientCapabilities: FORM_ELICITATION_CAPABILITIES,
  extensions: answerFormElicitations,
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
