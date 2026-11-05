import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIRO_LOGIN = 'kiro-cli login';

export function parseKiroWhoami(output: string): ProviderReadiness {
  try {
    const result: unknown = JSON.parse(output);
    if (!result || typeof result !== 'object' || !('account' in result)) throw new Error();
    const account = result.account;
    if (account === null) return readiness('unauthenticated', signInWith(KIRO_LOGIN));
    if (account && typeof account === 'object')
      return readiness('authenticated', 'Signed in to Kiro CLI.');
  } catch {
    // A status command that does not return its documented JSON cannot establish readiness.
  }
  return readiness('unknown', 'Could not verify Kiro CLI authentication. Check the CLI setup.');
}

/** Kiro CLI V3 uses ACP configuration options for models and CLI-owned credentials. */
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
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw error;
      output = commandOutput(error);
    }
    return parseKiroWhoami(output);
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
