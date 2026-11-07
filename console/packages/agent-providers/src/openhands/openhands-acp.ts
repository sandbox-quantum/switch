import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const OPENHANDS_LOGIN = 'openhands login';

export function parseOpenhandsStatus(output: string): ProviderReadiness {
  if (
    /not configured|not logged in|no api key|authentication required|login required/i.test(output)
  ) {
    return readiness('unauthenticated', signInWith(OPENHANDS_LOGIN));
  }
  if (/openhands|ready|configured|active|version/i.test(output)) {
    return readiness('authenticated', 'Configured.');
  }
  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

/** OpenHands CLI `openhands acp` provider hooks. */
export const openhandsAcp: AcpProviderHooks = {
  provider: 'openhands',
  label: 'OpenHands CLI',
  defaultBinary: 'openhands',
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
  loginCommand: OPENHANDS_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (
      env.OPENHANDS_API_KEY?.trim() ||
      env.LLM_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim()
    ) {
      return readiness('authenticated', 'Signs in with the API key it was given.');
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
    return parseOpenhandsStatus(output);
  },
  authMethodId: (env) =>
    env.OPENHANDS_API_KEY?.trim() || env.LLM_API_KEY?.trim() || env.OPENAI_API_KEY?.trim()
      ? undefined
      : 'openhands_login',
  promptCapabilities: { image: true },
  sessionMode: () => 'agent',
};

export function createOpenhandsAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(openhandsAcp, options);
}
