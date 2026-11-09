import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import { PI_SIGN_IN, piLaunch, piSignedIn } from './runtime';

const PI_LOGIN = 'pi login';

/** Pi's ACP adapter via `pi-acp` / `pi --mode acp`. */
export const piAcp: AcpProviderHooks = {
  provider: 'pi',
  label: 'Pi CLI',
  defaultBinary: 'pi',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: piLaunch,
  loginCommand: PI_LOGIN,
  inheritEnv: [
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'MISTRAL_API_KEY',
  ],
  checkSignIn: async ({ env }) => {
    try {
      const signedIn = await piSignedIn(env);
      return signedIn
        ? readiness('authenticated', 'Signed in to Pi CLI.')
        : readiness('unauthenticated', PI_SIGN_IN);
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error))) {
        return readiness('unauthenticated', PI_SIGN_IN);
      }
      throw error;
    }
  },
  promptCapabilities: { image: true },
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'yolo';
      case 'auto-accept-edits':
      case 'auto':
        return 'auto_edit';
      case 'approval-required':
      default:
        return 'default';
    }
  },
  nativeSessionIdPrefix: {
    prefix: 'pi:',
    legacyMessage:
      'This conversation belongs to a previous Pi session. Start a fresh session; the existing transcript is preserved.',
  },
  mcpServerOf: (toolCall) => {
    const meta = toolCall._meta as
      | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
      | undefined;
    return meta?.is_mcp_tool_call === true && typeof meta.mcp?.server === 'string'
      ? meta.mcp.server
      : undefined;
  },
};

export function createPiAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(piAcp, options);
}
