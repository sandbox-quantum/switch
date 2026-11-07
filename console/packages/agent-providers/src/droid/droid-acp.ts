import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const DROID_LOGIN = 'droid login';

/** Factory Droid's `droid exec --output-format acp` on generic ACP adapter. */
export const droidAcp: AcpProviderHooks = {
  provider: 'droid',
  label: 'Factory Droid',
  defaultBinary: 'droid',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['exec', '--output-format', 'acp'],
    env,
  }),
  loginCommand: DROID_LOGIN,
  inheritEnv: ['FACTORY_API_KEY', 'DROID_API_KEY'],
  checkSignIn: async ({ handshake, env }) => {
    if (env.FACTORY_API_KEY?.trim() || env.DROID_API_KEY?.trim()) {
      return readiness('authenticated', 'Signs in with the Factory API key it was given.');
    }
    try {
      const init = await handshake();
      if (!init.authMethods || init.authMethods.length === 0) {
        return readiness('authenticated', 'Signed in to Factory Droid.');
      }
      return readiness('unauthenticated', signInWith(DROID_LOGIN));
    } catch (error) {
      if (/sign in|auth required|unauthenticated/i.test(String(error))) {
        return readiness('unauthenticated', signInWith(DROID_LOGIN));
      }
      throw error;
    }
  },
  promptCapabilities: { image: true, embeddedContext: true },
  sessionMode: (runtimeMode, _modes) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'high';
      case 'auto-accept-edits':
      case 'auto':
        return 'medium';
      case 'approval-required':
        return 'low';
    }
  },
  mcpServerOf: (toolCall) => {
    const meta = toolCall._meta as
      | { server?: unknown; mcp?: { server?: unknown }; is_mcp_tool_call?: boolean }
      | undefined;
    if (typeof meta?.server === 'string' && meta.server) {
      return meta.server;
    }
    if (typeof meta?.mcp?.server === 'string' && meta.mcp.server) {
      return meta.mcp.server;
    }
    const raw = toolCall.rawInput as { server?: unknown; providerIdentifier?: unknown } | undefined;
    if (typeof raw?.providerIdentifier === 'string' && raw.providerIdentifier) {
      return raw.providerIdentifier;
    }
    if (typeof raw?.server === 'string' && raw.server) {
      return raw.server;
    }
    return undefined;
  },
};

export function createDroidAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(droidAcp, options);
}
