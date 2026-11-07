import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, SIGNED_OUT_ERROR, signInWith } from '../readiness';

const JUNIE_LOGIN = 'junie';
// Junie words its refusal "Authentication is required before this operation
// can be performed", which `SIGNED_OUT_ERROR` does not match.
const JUNIE_SIGNED_OUT = /authentication is required/i;

/** JetBrains' Junie CLI, `junie --acp=true`. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    // The generic ACP adapter runs a message sent mid-turn as the next turn.
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp=true'], env }),
  // Junie has no sign-in subcommand: running it shows a welcome screen that
  // offers a JetBrains account, a Junie API key or a provider key.
  loginCommand: JUNIE_LOGIN,
  // The access token variable in Junie's documentation.
  inheritEnv: ['JUNIE_API_KEY'],
  // `initialize` answers the same signed in or out, and `authenticate` would
  // start a browser sign-in, so the check asks for the session list, which a
  // signed-out Junie refuses and which creates nothing.
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    try {
      await request('session/list', {});
      return readiness('authenticated', 'Signed in to Junie.');
    } catch (error) {
      const message = String(error);
      if (SIGNED_OUT_ERROR.test(message) || JUNIE_SIGNED_OUT.test(message))
        return readiness(
          'unauthenticated',
          `${signInWith(JUNIE_LOGIN)} Choose a sign-in option on its welcome screen.`
        );
      throw error;
    }
  },
};

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
