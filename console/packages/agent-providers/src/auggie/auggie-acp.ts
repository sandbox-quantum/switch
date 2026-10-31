import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpProviderHooks, AcpAdapterOptions } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie auth login';

export function parseAuggieAuthStatus(output: string): ProviderReadiness {
  if (/not logged in|not authenticated|unauthenticated/i.test(output)) {
    return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  }

  if (/logged in/i.test(output)) {
    return readiness('authenticated', 'Auggie CLI is authenticated.');
  }

  return readiness(
    'unknown',
    'Could not verify Auggie CLI authentication. Check provider setup and try again.'
  );
}

export const auggieAcp: AcpProviderHooks = {
  provider: 'auggie',
  label: 'Auggie',
  defaultBinary: 'auggie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  noLegacySetModel: true,
  promptCapabilities: {
    image: true,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
  }),
  loginCommand: AUGGIE_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
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
      const processError = error as NodeJS.ErrnoException & {
        stdout?: unknown;
        stderr?: unknown;
      };

      if (
        processError.code === 'ENOENT' ||
        /not found|not recognized|no such file/i.test(processError.message ?? '')
      ) {
        return readiness(
          'unconfigured',
          'Auggie CLI is not installed or not available on PATH. Install Auggie CLI to continue.'
        );
      }

      const stdout = commandOutput(error);
      const stderr = typeof processError.stderr === 'string' ? processError.stderr : '';
      output = [stdout, stderr].filter(Boolean).join('\n');

      if (!output.trim()) {
        return readiness(
          'unknown',
          'Could not verify Auggie CLI authentication. Check provider setup and try again.'
        );
      }
    }

    return parseAuggieAuthStatus(output);
  },
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
