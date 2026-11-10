import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';

export const MISTRAL_VIBE_LOGIN = 'vibe-acp --setup';

/** Vibe 3.1's native ACP server; protocol and session lifecycle stay in the shared adapter. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  loginCommand: MISTRAL_VIBE_LOGIN,
  inheritEnv: ['VIBE_HOME'],
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: [],
    // Session environments omit the Linux keyring bus. Readiness must use the same credentials.
    env: Object.fromEntries(
      Object.entries(env).filter(([key]) => key !== 'DBUS_SESSION_BUS_ADDRESS')
    ),
  }),
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    const status = await request<{ authenticated?: boolean }>('_auth/status', {});
    if (status.authenticated === true)
      return readiness('authenticated', 'Mistral Vibe has credentials for its active provider.');
    return readiness(
      status.authenticated === false ? 'unauthenticated' : 'unknown',
      `${signInWith(MISTRAL_VIBE_LOGIN)} On Linux, use MISTRAL_API_KEY or $VIBE_HOME/.env rather than a desktop-only keyring.`
    );
  },
  // 3.1 accepts HttpMcpServer in session/new but omits its initialize capability.
  mcpCapabilities: { http: true },
  sessionMode: (runtimeMode, modes) => {
    const mode = {
      'approval-required': 'ask',
      'auto-accept-edits': 'accept-edits',
      auto: 'smart-approve',
      'full-access': 'auto-approve',
    }[runtimeMode];
    if (!modes?.availableModes.some((available) => available.id === mode))
      throw new Error(
        `Mistral Vibe does not offer ${mode}, required for ${runtimeMode}. Enable that Vibe mode or choose another permission setting in Switch.`
      );
    return mode;
  },
  mcpServerOf: (call, serverNames) => {
    const tool = call._meta?.tool_name ?? call.toolCallId;
    const group = typeof tool === 'string' ? /^mcp_([^.]+)\./.exec(tool)?.[1] : undefined;
    if (!group) return undefined;
    const aliases = new Map<string, string>();
    for (const name of serverNames) {
      const alias = name.replace(/[^a-zA-Z0-9_$]/gu, '_') || '_';
      // Vibe hashes collisions using configuration Switch does not own. Do not guess a policy.
      if (aliases.has(alias)) return undefined;
      aliases.set(alias, name);
    }
    return aliases.get(group);
  },
  itemType: (call) => (call._meta?.effect_kind === 'subagent' ? 'subagent' : undefined),
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
