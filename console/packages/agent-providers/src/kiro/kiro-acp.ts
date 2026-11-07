import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpProviderHooks, AcpAdapterOptions } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const KIRO_LOGIN = 'kiro-cli login';

const SIGNED_OUT =
  /not logged in|not signed in|unauthenticated|authentication required|login required/i;

export function parseKiroWhoami(output: string): ProviderReadiness {
  let result: unknown;

  try {
    result = JSON.parse(output);
  } catch {
    if (SIGNED_OUT.test(output)) {
      return readiness('unauthenticated', signInWith(KIRO_LOGIN));
    }

    return readiness(
      'unknown',
      'Could not verify Kiro CLI authentication. Check provider setup and try again.'
    );
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return readiness('unknown', 'Kiro CLI returned an unexpected sign-in status response.');
  }

  const account = result as Record<string, unknown>;

  // Verified Kiro CLI 2.36.0 signed-out response.
  if (account.account === null) {
    return readiness('unauthenticated', signInWith(KIRO_LOGIN));
  }

  // Verified Kiro CLI 2.36.0 signed-in response.
  if (
    typeof account.accountType === 'string' &&
    account.accountType.length > 0 &&
    typeof account.provider === 'string' &&
    account.provider.length > 0
  ) {
    return readiness('authenticated', 'Kiro CLI is authenticated.');
  }

  const values = Object.values(account);
  const text = values.filter((value): value is string => typeof value === 'string').join(' ');

  if (SIGNED_OUT.test(text)) {
    return readiness('unauthenticated', signInWith(KIRO_LOGIN));
  }

  return readiness(
    'unknown',
    'Kiro CLI returned JSON, but its authentication status could not be verified.'
  );
}

export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  noLegacySetModel: true,
  itemType: (toolCall) => {
    if (
      toolCall.toolCallId.startsWith('invoke_subagent_') ||
      toolCall.title?.startsWith('Sub-agent:')
    ) {
      return 'subagent';
    }

    return undefined;
  },
  mcpServerOf: (toolCall) => {
    const kiro = toolCall._meta?.kiro;

    if (typeof kiro !== 'object' || kiro === null) {
      return undefined;
    }

    const serverName = (kiro as Record<string, unknown>).serverName;

    return typeof serverName === 'string' ? serverName : undefined;
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp', '--agent-engine=v3'],
    env,
  }),
  loginCommand: KIRO_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;

    try {
      output = (
        await execProvider(binaryPath, ['whoami', '--format', 'json'], {
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
          'Kiro CLI is not installed or not available on PATH. Install Kiro CLI to continue.'
        );
      }

      const stdout = commandOutput(error);
      const stderr = typeof processError.stderr === 'string' ? processError.stderr : '';

      output = [stdout, stderr].filter(Boolean).join('\n');

      if (!output.trim()) {
        return readiness(
          'unknown',
          'Could not verify Kiro CLI authentication. Check provider setup and try again.'
        );
      }
    }

    return parseKiroWhoami(output);
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
