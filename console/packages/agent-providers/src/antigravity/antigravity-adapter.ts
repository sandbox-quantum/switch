import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import {
  ANTIGRAVITY_SIGN_IN,
  antigravityLaunch,
  antigravityProfile,
  antigravitySignedIn,
} from './runtime';

/** Antigravity's `antigravity-acp`, whose questions arrive as permission requests. */
export const antigravityAcp: AcpProviderHooks = {
  provider: 'antigravity',
  label: 'Antigravity',
  defaultBinary: 'antigravity-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: antigravityLaunch,
  loginCommand: 'antigravity-acp --login',
  unsupportedPlatforms: {
    win32: 'Antigravity ACP has no Windows build, so it cannot run on Windows.',
  },
  // `authMethods` is the agent's own answer: the sign-ins it still wants.
  // Calling `authenticate` here would not test the sign-in but perform it,
  // opening a browser.
  // 1.3 lists every method whether or not one is in use, so an outstanding
  // method is only signed out when the profile holds no token either.
  checkSignIn: async ({ handshake, env }) => {
    try {
      return !(await handshake()).authMethods?.length ||
        (await antigravitySignedIn(antigravityProfile(env)))
        ? readiness('authenticated', 'Signed in to Antigravity ACP.')
        : readiness('unauthenticated', ANTIGRAVITY_SIGN_IN);
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error)))
        return readiness('unauthenticated', ANTIGRAVITY_SIGN_IN);
      throw error;
    }
  },
  // Opens a browser when the profile holds no usable token, which is why
  // only a session start sends it and the sign-in check never does.
  authMethodId: () => 'oauth-personal',
  promptCapabilities: { image: true, audio: true, embeddedContext: true },
  sessionMode: (runtimeMode) =>
    runtimeMode === 'full-access'
      ? 'yolo'
      : runtimeMode === 'auto-accept-edits'
        ? 'auto_edit'
        : 'default',
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
