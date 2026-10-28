import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const JUNIE_LOGIN = 'junie login';

/** JetBrains Junie's `junie --acp=true`. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp=true'], env }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: ['JUNIE_API_KEY'],
  checkSignIn: async ({ handshake, env }) => {
    if (env.JUNIE_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Junie API key it was given.');
    }
    try {
      const result = await handshake();
      if (result.authMethods?.length) {
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
      }
      return readiness('authenticated', 'Signed in to Junie.');
    } catch (error) {
      if (/sign.?in|auth|unauthenticated|unauthorized|login/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
      }
      throw error;
    }
  },
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
