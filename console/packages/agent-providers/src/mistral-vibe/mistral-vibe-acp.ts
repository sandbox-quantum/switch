import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { readiness, signInWith } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export const MISTRAL_VIBE_LOGIN = 'vibe-acp --setup';

/**
 * Vibe 3.1.0: https://github.com/mistralai/mistral-vibe/tree/v3.1.0/vibe/acp
 * Use its read-only auth/status extension: initialize.authMethods lists available
 * methods even when credentials already exist in the environment or OS keyring.
 */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  loginCommand: MISTRAL_VIBE_LOGIN,
  inheritEnv: [
    'VIBE_HOME',
    'VIBE_CUSTOM_CONSOLE_URL',
    'DBUS_SESSION_BUS_ADDRESS',
    'XDG_RUNTIME_DIR',
  ],
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: [], env }),
  checkSignIn: async (input) => {
    const client = new StdioJsonRpcClient({
      command: input.binaryPath,
      args: [],
      cwd: input.cwd,
      env: input.env,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await acpInitialize(client);
      const status = await client.request<{ authenticated?: unknown }>('_auth/status', {});
      if (status?.authenticated === true)
        return readiness('authenticated', "Mistral Vibe's active provider is configured for use.");
      if (status?.authenticated === false)
        return readiness('unauthenticated', signInWith(MISTRAL_VIBE_LOGIN));
      return readiness(
        'unknown',
        `Could not verify Mistral Vibe authentication. Run ${MISTRAL_VIBE_LOGIN} on the execution machine.`
      );
    } finally {
      await client.dispose();
    }
  },
  // agent.py accepts HttpMcpServer in new_session/_project_acp_mcp_servers, but
  // 3.1.0 omits mcpCapabilities from initialize. Never override an explicit false.
  mcpCapabilities: { http: true },
  conversationUnavailable: (error) =>
    error instanceof JsonRpcError &&
    error.code === -32602 &&
    error.message.startsWith('Session not found:') &&
    typeof error.data === 'object' &&
    error.data !== null &&
    'session_id' in error.data &&
    typeof error.data.session_id === 'string',
  sessionMode: (mode) => {
    switch (mode) {
      case 'approval-required':
        return 'ask';
      case 'auto-accept-edits':
        return 'accept-edits';
      // smart-approve is account/config dependent and is absent from the
      // default 3.1.0 modes. Keep requests visible without a native reviewer.
      case 'auto':
        return 'ask';
      case 'full-access':
        return 'auto-approve';
    }
  },
  // Vibe uses allow_always for both session and disk-persisted policies.
  // Filter by its option IDs, including path grants, regardless of display order.
  permissionOptions: (options) =>
    options.filter((option) => !option.optionId.includes('permanent')),
  itemType: (toolCall) => (toolCall._meta?.effect_kind === 'subagent' ? 'subagent' : undefined),
  mcpServerOf: (toolCall, serverNames) => {
    const name = toolCall._meta?.tool_name;
    if (typeof name !== 'string') return undefined;
    const alias = /^mcp_([^.]+)\./.exec(name)?.[1];
    if (!alias) return undefined;
    // Collisions get hash suffixes in Vibe. Don't confuse one of those with a
    // different registered server whose literal name happens to be that suffix.
    const names = [...serverNames].map(
      (server) => [server, server.replace(/[^a-zA-Z0-9_$]/gu, '_') || '_'] as const
    );
    if (new Set(names.map(([, normalized]) => normalized)).size !== names.length) return undefined;
    const matches = names
      .filter(([, normalized]) => normalized === alias)
      .map(([server]) => server);
    return matches.length === 1 ? matches[0] : undefined;
  },
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
