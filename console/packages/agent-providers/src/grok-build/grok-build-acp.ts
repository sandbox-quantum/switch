import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const GROK_BUILD_LOGIN = 'grok login';

/** Grok Build's `grok agent stdio`, speaking ACP. */
export const grokBuildAcp: AcpProviderHooks = {
  provider: 'grok-build',
  label: 'Grok Build',
  defaultBinary: 'grok',
  capabilities: {
    modelSwitchInSession: false,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['agent', 'stdio'],
    env,
  }),
  loginCommand: GROK_BUILD_LOGIN,
  inheritEnv: ['XAI_API_KEY'],
  checkSignIn: async ({ handshake, env }) => {
    if (env.XAI_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the xAI API key it was given.');
    }
    try {
      const result = await handshake();
      if (result.authMethods?.some((method) => method.id === 'cached_token')) {
        return readiness('authenticated', 'Signed in to Grok Build.');
      }
      if (result.authMethods?.length) {
        return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      }
      return readiness('unknown', signInWith(GROK_BUILD_LOGIN));
    } catch (error) {
      if (/sign.?in|auth|unauthenticated|unauthorized|login/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(GROK_BUILD_LOGIN));
      }
      return readiness('unknown', signInWith(GROK_BUILD_LOGIN));
    }
  },
  mcpServerOf: (toolCall) => {
    const rawInput = toolCall.rawInput as { tool_name?: string } | undefined;
    const toolName = rawInput?.tool_name ?? toolCall.title ?? '';
    if (toolName.includes('__')) return toolName.split('__')[0];
    const rawOutput = toolCall.rawOutput as { server_name?: string } | undefined;
    return typeof rawOutput?.server_name === 'string' ? rawOutput.server_name : undefined;
  },
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
