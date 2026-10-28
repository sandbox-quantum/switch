import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const GROK_BUILD_LOGIN = 'grok auth login';

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
  checkSignIn: async ({ env }) => {
    if (env.XAI_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the xAI API key it was given.');
    }
    return readiness('unknown', signInWith(GROK_BUILD_LOGIN));
  },
};

export function createGrokBuildAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(grokBuildAcp, options);
}
