import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSignInInput } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

export const MISTRAL_VIBE_LOGIN = 'vibe-acp --setup';

interface VibeAuthStatus {
  authenticated?: boolean;
}

async function checkMistralVibeSignIn(input: AcpSignInInput): Promise<ProviderReadiness> {
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
    const status = await client.request<VibeAuthStatus>('_auth/status', {});
    return status.authenticated === true
      ? readiness('authenticated', 'Signed in to Mistral Vibe.')
      : readiness('unauthenticated', signInWith(MISTRAL_VIBE_LOGIN));
  } finally {
    await client.dispose();
  }
}

function mcpServerOf(toolCall: AcpToolCall, serverNames?: ReadonlySet<string>): string | undefined {
  const toolName = toolCall._meta?.tool_name;
  if (typeof toolName !== 'string') return undefined;
  const alias = /^mcp_(.+?)\./.exec(toolName)?.[1];
  if (!alias || !serverNames) return alias;
  // Vibe replaces characters other than letters, digits, `_` and `$` with `_`
  // when it builds `mcp_<server>.<tool>` names. Map the alias back to the
  // original Switch key so connector attribution and approval policy survive
  // names such as `google-workspace`. If two keys collapse to the same alias,
  // leave the call unattributed so it cannot inherit either server's policy.
  const matches = [...serverNames].filter(
    (name) => name.replace(/[^a-zA-Z0-9_$]/g, '_') === alias
  );
  if (matches.length > 1) return undefined;
  return matches[0] ?? alias;
}

/** Mistral Vibe's native `vibe-acp` server. */
export const mistralVibeAcp: AcpProviderHooks = {
  provider: 'mistral-vibe',
  label: 'Mistral Vibe',
  defaultBinary: 'vibe-acp',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: [], env }),
  loginCommand: MISTRAL_VIBE_LOGIN,
  checkSignIn: checkMistralVibeSignIn,
  // Vibe 3.0.2 accepts HTTP MCP servers but omits mcpCapabilities.http from
  // initialize, so use the provider fallback until the CLI advertises it.
  mcpCapabilities: { http: true },
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'auto-approve';
      case 'auto-accept-edits':
        return 'accept-edits';
      case 'auto':
        return 'smart-approve';
      case 'approval-required':
        return 'ask';
    }
  },
  mcpServerOf,
  itemType: (toolCall) => (toolCall._meta?.effect_kind === 'subagent' ? 'subagent' : undefined),
};

export function createMistralVibeAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(mistralVibeAcp, options);
}
