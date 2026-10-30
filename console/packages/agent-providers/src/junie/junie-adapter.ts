import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const JUNIE_LOGIN = 'junie login';

/** Junie's `junie --acp=true`, running on the generic ACP adapter. */
export const junieAcp: AcpProviderHooks = {
  provider: 'junie',
  label: 'Junie',
  defaultBinary: 'junie',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp=true'],
    env,
    rejectOutputLine: (line) =>
      /not (?:logged|signed) in|log.?in required|sign.?in required|junie login|auth required/i.test(
        line
      )
        ? 'Junie is not signed in. Run `junie login` on the machine.'
        : undefined,
  }),
  loginCommand: JUNIE_LOGIN,
  inheritEnv: ['JUNIE_API_KEY', 'JUNIE_AUTH_TOKEN', 'JUNIE_TOKEN', 'JETBRAINS_AI_TOKEN'],
  checkSignIn: async ({ handshake, env }) => {
    if (
      env.JUNIE_API_KEY?.trim() ||
      env.JUNIE_AUTH_TOKEN?.trim() ||
      env.JUNIE_TOKEN?.trim() ||
      env.JETBRAINS_AI_TOKEN?.trim()
    ) {
      return readiness('authenticated', 'Signs in with the Junie API key it was given.');
    }
    try {
      const init = await handshake();
      return !init.authMethods?.length
        ? readiness('authenticated', 'Signed in.')
        : readiness('unauthenticated', signInWith(JUNIE_LOGIN));
    } catch (error) {
      if (
        /not (?:logged|signed) in|log.?in required|sign.?in required|auth(?:entication)? required|unauthenticated|unauthorized/i.test(
          String(error)
        )
      ) {
        return readiness('unauthenticated', signInWith(JUNIE_LOGIN));
      }
      throw error;
    }
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

export function createJunieAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(junieAcp, options);
}
