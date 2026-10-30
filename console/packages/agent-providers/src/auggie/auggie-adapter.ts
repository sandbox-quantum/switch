import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const AUGGIE_LOGIN = 'auggie login';

/**
 * Parses the output of `auggie token print`.
 * When logged in, it prints valid JSON containing session data.
 * When not logged in, it prints an error message and exits with a nonzero status.
 */
export function parseAuggieTokenPrint(output: string): ProviderReadiness {
  const trimmed = output.trim();
  if (
    !trimmed ||
    /not logged in|not authenticated|login required|authentication required|not signed in|no active session|token not found/i.test(
      trimmed
    )
  ) {
    return readiness('unauthenticated', signInWith(AUGGIE_LOGIN));
  }
  try {
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed === 'object' && parsed !== null) {
        return readiness('authenticated', 'Signed in.');
      }
    }
  } catch {
    // If not JSON or invalid
  }
  return /error|fail/i.test(trimmed)
    ? readiness('unauthenticated', signInWith(AUGGIE_LOGIN))
    : readiness('unknown', 'Could not verify authentication. Check provider setup and try again.');
}

/** Auggie's `auggie --acp`, running on the generic ACP adapter. */
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
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp'],
    env,
    rejectOutputLine: (line) =>
      /not (?:logged|signed) in|log.?in required|sign.?in required|auggie login/i.test(line)
        ? 'Auggie is not signed in. Run `auggie login` on the machine.'
        : undefined,
  }),
  loginCommand: AUGGIE_LOGIN,
  inheritEnv: ['AUGMENT_SESSION_AUTH'],
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.AUGMENT_SESSION_AUTH?.trim())
      return readiness(
        'authenticated',
        'Signs in with the Augment session authentication it was given.'
      );
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['token', 'print'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseAuggieTokenPrint(output);
  },
  promptCapabilities: { image: true },
  mcpServerOf: (toolCall) => {
    const meta = toolCall._meta as
      | { is_mcp_tool_call?: boolean; mcp?: { server?: unknown } }
      | undefined;
    if (meta?.is_mcp_tool_call === true && typeof meta.mcp?.server === 'string') {
      return meta.mcp.server;
    }
    const raw = toolCall.rawInput as { providerIdentifier?: unknown } | undefined;
    if (typeof raw?.providerIdentifier === 'string' && raw.providerIdentifier) {
      return raw.providerIdentifier;
    }
    return undefined;
  },
};

export function createAuggieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(auggieAcp, options);
}
