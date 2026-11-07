import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const GOOSE_LOGIN = 'goose configure';

export function parseGooseStatus(output: string): ProviderReadiness {
  if (
    /no provider configured|no api key|not configured|login required|run goose configure/i.test(
      output
    )
  ) {
    return readiness('unauthenticated', signInWith(GOOSE_LOGIN));
  }
  if (/goose|configured|active|version/i.test(output)) {
    return readiness('authenticated', 'Configured.');
  }
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/** Block's Goose CLI `goose acp` provider hooks. */
export const gooseAcp: AcpProviderHooks = {
  provider: 'goose',
  label: 'Goose CLI',
  defaultBinary: 'goose',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env, autoApprove }) => ({
    command: binaryPath,
    args: ['acp', ...(autoApprove ? ['--auto-approve', 'true'] : [])],
    env,
  }),
  loginCommand: GOOSE_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (
      env.GOOSE_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim() ||
      env.DATABRICKS_API_KEY?.trim()
    ) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
    }
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['info'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseGooseStatus(output);
  },
  authMethodId: (env) =>
    env.GOOSE_API_KEY?.trim() || env.OPENAI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim()
      ? undefined
      : 'goose_login',
  promptCapabilities: { image: true },
  sessionMode: () => 'agent',
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
