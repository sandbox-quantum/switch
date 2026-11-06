import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const CLINE_LOGIN = 'cline auth';

export function parseClineAuth(output: string): ProviderReadiness {
  if (
    /not logged in|not authenticated|login required|authentication required|not signed in|no credentials/i.test(
      output
    )
  ) {
    return readiness('unauthenticated', signInWith(CLINE_LOGIN));
  }
  if (/logged in|authenticated|signed in|active account/i.test(output)) {
    return readiness('authenticated', 'Signed in.');
  }
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/** Cline CLI's `cline --acp` provider hooks. */
export const clineAcp: AcpProviderHooks = {
  provider: 'cline',
  label: 'Cline CLI',
  defaultBinary: 'cline',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env, autoApprove }) => ({
    command: binaryPath,
    args: ['--acp', ...(autoApprove ? ['--auto-approve', 'true'] : [])],
    env,
  }),
  loginCommand: CLINE_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.CLINE_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
    }
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['auth', 'status'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseClineAuth(output);
  },
  authMethodId: (env) =>
    env.CLINE_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
      ? undefined
      : 'cline_auth',
  promptCapabilities: { image: true },
  sessionMode: () => 'agent',
};

export function createClineAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(clineAcp, options);
}
