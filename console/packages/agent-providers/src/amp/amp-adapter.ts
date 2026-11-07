import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import { AMP_SIGN_IN, ampLaunch, ampSignedIn } from './runtime';

const AMP_LOGIN = 'amp login';

/** Amp's ACP adapter via `amp-acp` or `amp acp`. */
export const ampAcp: AcpProviderHooks = {
  provider: 'amp',
  label: 'Amp CLI',
  defaultBinary: 'amp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ampLaunch,
  loginCommand: AMP_LOGIN,
  inheritEnv: ['AMP_API_KEY', 'SOURCEGRAPH_TOKEN', 'SRC_ACCESS_TOKEN', 'SRC_ENDPOINT'],
  checkSignIn: async ({ env }) => {
    try {
      const signedIn = await ampSignedIn(env);
      return signedIn
        ? readiness('authenticated', 'Signed in to Amp CLI.')
        : readiness('unauthenticated', AMP_SIGN_IN);
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error))) {
        return readiness('unauthenticated', AMP_SIGN_IN);
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
    prefix: 'amp:',
    legacyMessage:
      'This conversation belongs to a previous Amp session. Start a fresh session; the existing transcript is preserved.',
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

export function createAmpAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(ampAcp, options);
}
