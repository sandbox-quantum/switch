import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const GOOSE_LOGIN = 'goose configure';

/**
 * Parses `goose info` output to determine configuration / readiness.
 */
export function parseGooseInfo(output: string): ProviderReadiness {
  if (
    /no provider configured|not configured|please configure|run goose configure|configuration value not found|no model configured/i.test(
      output
    )
  )
    return readiness('unauthenticated', signInWith(GOOSE_LOGIN));

  const provider = output.match(/Active Provider(?:[ \t]*:[ \t]*|[ \t]+)(.+)/i)?.[1]?.trim();
  if (provider && !/none|null|disabled|not configured/i.test(provider))
    return readiness('authenticated', `Configured with ${provider}.`);

  if (/goose is ready|-\s*([a-zA-Z0-9_-]+):\s*Enabled/i.test(output))
    return readiness('authenticated', 'Configured.');

  return readiness('unauthenticated', signInWith(GOOSE_LOGIN));
}

/** Goose's `goose acp` provider runtime hooks. */
export const gooseAcp: AcpProviderHooks = {
  provider: 'goose',
  label: 'Goose',
  defaultBinary: 'goose',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env,
  }),
  loginCommand: GOOSE_LOGIN,
  inheritEnv: [
    'GOOSE_PROVIDER',
    'GOOSE_MODEL',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'OLLAMA_HOST',
  ],
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.GOOSE_PROVIDER?.trim())
      return readiness('authenticated', 'Configured with the GOOSE_PROVIDER environment variable.');
    if (
      env.GOOGLE_API_KEY?.trim() ||
      env.GEMINI_API_KEY?.trim() ||
      env.OPENAI_API_KEY?.trim() ||
      env.ANTHROPIC_API_KEY?.trim()
    )
      return readiness('authenticated', 'Configured with API key in environment.');
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['doctor'], {
          cwd,
          env,
          timeout: 4000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseGooseInfo(output);
  },
  promptCapabilities: { image: true },
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'auto';
      case 'auto-accept-edits':
      case 'auto':
        return 'smart_approve';
      case 'approval-required':
      default:
        return 'approve';
    }
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
