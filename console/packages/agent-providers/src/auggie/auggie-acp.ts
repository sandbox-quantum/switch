import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';

export function parseAuggieStatus(output: string): ProviderReadiness {
  if (
    /not logged in|not authenticated|login required|authentication required|not signed in/i.test(
      output
    )
  ) {
    return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  }
  if (/logged in|authenticated|active|signed in|auggie/i.test(output)) {
    return readiness('authenticated', 'Signed in.');
  }
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/** Augment Code's Auggie CLI `auggie --acp` provider hooks. */
export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie CLI',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // Auggie has no auto-approve flag, so autoApprove requests approval through standard ACP channels.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: AUGGIE_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.AUGMENT_API_KEY?.trim() || env.AUGGIE_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Augment API key it was given.');
    }
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['status'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseAuggieStatus(output);
  },
  authMethodId: (env) =>
    env.AUGMENT_API_KEY?.trim() || env.AUGGIE_API_KEY?.trim() ? undefined : 'auggie_login',
  promptCapabilities: { image: true },
  sessionMode: () => 'agent',
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
