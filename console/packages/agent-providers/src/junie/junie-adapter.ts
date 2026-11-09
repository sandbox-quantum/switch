import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

const JUNIE_LOGIN = 'junie';

/** JetBrains' `junie --acp=true`. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: true,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp=true'], env }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: ['JUNIE_API_KEY'],
  // With a key the agent reports itself signed in. Without one it lists the
  // account sign-in whether or not an account is signed in, so the handshake
  // cannot tell the two apart. `authenticate` would start the sign-in, so it
  // is never called here.
  checkSignIn: async ({ handshake, env }) => {
    if (env.JUNIE_API_KEY?.trim())
      return readiness('authenticated', 'Signed in with JUNIE_API_KEY.');
    try {
      return (await handshake()).authMethods?.length
        ? readiness('unknown', `Could not verify the sign-in. ${signInWith(JUNIE_LOGIN)}`)
        : readiness('authenticated', 'Signed in to Junie.');
    } catch (error) {
      if (/authentication is required|sign in|unauthenticated|not logged in/i.test(String(error)))
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
      throw error;
    }
  },
  // Sent only when a session starts, and not with a key, which already signs the agent in.
  authMethodId: (env) => (env.JUNIE_API_KEY?.trim() ? undefined : 'jetbrains-account'),
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
