import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';

const VIBE_LOGIN = 'vibe --setup';

/** Credentials Vibe reads: the shell key, then `~/.vibe/.env`. Keyring entries are not file-readable. */
async function vibeSignedIn(env: Record<string, string>): Promise<boolean> {
  if (env.MISTRAL_API_KEY?.trim()) return true;
  const home = env.HOME || env.USERPROFILE;
  if (!home) return false;
  try {
    const contents = await readFile(join(home, '.vibe', '.env'), 'utf8');
    return /^MISTRAL_API_KEY\s*=/m.test(contents);
  } catch {
    return false;
  }
}

/** Mistral Vibe's `vibe-acp`, ACP over stdio. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: [], env }),
  loginCommand: 'vibe --setup',
  // MISTRAL_API_KEY is already on the session host's inherit list; nothing
  // further to ask the machine for.
  inheritEnv: [],
  // A key in the environment or `~/.vibe/.env` already signs Vibe in; the
  // handshake's own authMethods answer covers a keyring login the check
  // cannot read. `authenticate` is never sent from the sign-in check.
  checkSignIn: async ({ env, handshake }): Promise<ProviderReadiness> => {
    if (await vibeSignedIn(env))
      return readiness('authenticated', 'Signs in with the Mistral API key it was given.');
    try {
      const init = await handshake();
      return !init.authMethods?.length
        ? readiness('authenticated', 'Signed in.')
        : readiness('unauthenticated', signInWith(VIBE_LOGIN));
    } catch (error) {
      if (/sign[ -]?in|authenticat|unauthenticated|api key/i.test(String(error)))
        return readiness('unauthenticated', signInWith(VIBE_LOGIN));
      throw error;
    }
  },
  // With a key the environment already signs Vibe in; without one the CLI
  // uses its keyring or `~/.vibe/.env`, and a host cannot finish a browser
  // sign-in, so no `authenticate` method is sent.
  authMethodId: () => undefined,
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
