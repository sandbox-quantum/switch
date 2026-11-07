import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const MISTRAL_VIBE_LOGIN = 'vibe';

/** Mistral Vibe's `vibe-acp`, listed in the ACP registry as `mistral-vibe`. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: [], env }),
  loginCommand: MISTRAL_VIBE_LOGIN,
  // A set MISTRAL_API_KEY means the CLI is authenticated without an
  // interactive session. The handshake check would trigger a browser
  // sign-in that a headless host cannot finish, so a present key is
  // taken as given; a bad key fails on the first turn.
  checkSignIn: async ({ handshake, env }) => {
    if (env.MISTRAL_API_KEY?.trim())
      return readiness(
        'authenticated',
        'Signed in to Mistral Vibe with the API key it was given.'
      );
    try {
      const initialized = await handshake();
      if (!(initialized.authMethods && initialized.authMethods.length))
        return readiness('authenticated', 'Signed in to Mistral Vibe.');
      return readiness(
        'unauthenticated',
        signInWith(MISTRAL_VIBE_LOGIN)
      );
    } catch (error) {
      const message = String(error);
      if (
        /not logged in|login required|authentication required|sign in required|not authenticated|api key/i.test(
          message
        )
      )
        return readiness('unauthenticated', signInWith(MISTRAL_VIBE_LOGIN));
      throw error;
    }
  },
  inheritEnv: ['MISTRAL_API_KEY'],
  promptCapabilities: { image: true },
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}

