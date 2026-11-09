import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness } from '../readiness';
import { AIDER_SIGN_IN, aiderLaunch, aiderSignedIn } from './runtime';

const AIDER_LOGIN = 'export OPENAI_API_KEY="sk-..."';

/** Aider's ACP adapter via `aider-acp` or `aider --acp`. */
export const aiderAcp: AcpProviderHooks = {
  provider: 'aider',
  label: 'Aider CLI',
  defaultBinary: 'aider',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: aiderLaunch,
  loginCommand: AIDER_LOGIN,
  inheritEnv: [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY',
    'GROQ_API_KEY',
    'OLLAMA_API_BASE',
    'OPENROUTER_API_KEY',
  ],
  checkSignIn: async ({ env }) => {
    try {
      const signedIn = await aiderSignedIn(env);
      return signedIn
        ? readiness('authenticated', 'Signed in to Aider CLI with environment API key.')
        : readiness('unauthenticated', AIDER_SIGN_IN);
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error))) {
        return readiness('unauthenticated', AIDER_SIGN_IN);
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
    prefix: 'aider:',
    legacyMessage:
      'This conversation belongs to a previous Aider session. Start a fresh session; the existing transcript is preserved.',
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

export function createAiderAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(aiderAcp, options);
}
