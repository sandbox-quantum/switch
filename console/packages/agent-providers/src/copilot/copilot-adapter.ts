import { randomUUID } from 'node:crypto';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ProviderSessionError } from '../adapter';
import {
  loginWontHelp,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

export const COPILOT_LOGIN = 'copilot login';

/**
 * Explicit passthrough for Console and headless hosts. In particular, a BYOK
 * endpoint alone activates that mode; an unrelated COPILOT_PROVIDER_* setting
 * does not establish authentication. Let the CLI resolve and check credentials.
 */
const COPILOT_ENV = [
  'COPILOT_HOME',
  'COPILOT_GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GH_HOST',
  'COPILOT_GH_HOST',
  'COPILOT_MODEL',
  'COPILOT_OFFLINE',
  'COPILOT_PROVIDERS_CONFIG',
  'COPILOT_PROVIDER_BASE_URL',
  'COPILOT_PROVIDER_TYPE',
  'COPILOT_PROVIDER_API_KEY',
  'COPILOT_PROVIDER_API_KEY_COMMAND',
  'COPILOT_PROVIDER_BEARER_TOKEN',
  'COPILOT_PROVIDER_WIRE_API',
  'COPILOT_PROVIDER_TRANSPORT',
  'COPILOT_PROVIDER_AZURE_API_VERSION',
  'COPILOT_PROVIDER_MODEL_ID',
  'COPILOT_PROVIDER_WIRE_MODEL',
  'COPILOT_PROVIDER_MAX_PROMPT_TOKENS',
  'COPILOT_PROVIDER_MAX_OUTPUT_TOKENS',
  'COPILOT_PROVIDER_HEADERS',
  // Linux Secret Service credentials need the execution machine's user bus.
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
] as const;

/**
 * 1.0.105 always advertises copilot-login, even when signed in. A saved account
 * or token's presence also cannot prove it is usable. Open an empty ACP session
 * instead: session/new checks credentials without authenticate, login or a
 * model prompt. Disposal releases it; Copilot may retain an empty history entry.
 * A successful check establishes session access, not inference quota.
 */
export async function checkCopilotSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  const adapter = createCopilotAdapter({ binaryPath: input.binaryPath });
  const sessionId = `copilot-readiness-${randomUUID()}`;
  try {
    await adapter.startSession({
      sessionId,
      cwd: input.cwd,
      env: input.env,
      runtimeMode: 'approval-required',
      mcpServers: {},
      connectorMcpServers: [],
    });
    return {
      ...readiness('authenticated', 'GitHub Copilot CLI accepted an ACP session.'),
      models: (await adapter.listModels(sessionId)).map(({ id, label }) => ({ id, name: label })),
    };
  } catch (error) {
    const cause = error instanceof ProviderSessionError ? error.cause : error;
    if (cause instanceof JsonRpcError) {
      if (/access denied|forbidden|policy|subscription|license/i.test(cause.message))
        return loginWontHelp(
          readiness('unconfigured', 'Check Copilot access, subscription and organization policy.')
        );
      if (
        /authentication required|unauthenticated|unauthorized|not logged in|no authentication|authentication failed|invalid token|expired token/i.test(
          cause.message
        )
      )
        return readiness('unauthenticated', signInWith(COPILOT_LOGIN));
    }
    // The host reports transport, configuration and unknown failures as unknown.
    // Never include raw CLI output here: it can contain credential material.
    throw error;
  } finally {
    await adapter.stopAll();
  }
}

/** GitHub Copilot CLI over the shared ACP session and permission machinery. */
export const copilotAcp: AcpProviderHooks = {
  provider: 'copilot',
  label: 'GitHub Copilot CLI',
  defaultBinary: 'copilot',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['--acp', '--stdio'],
    env,
  }),
  loginCommand: COPILOT_LOGIN,
  checkSignIn: checkCopilotSignIn,
  inheritEnv: COPILOT_ENV,
  mcpServerOf: (toolCall, names) => {
    if (
      toolCall.kind !== 'other' ||
      !('sessionUpdate' in toolCall) ||
      toolCall.sessionUpdate !== 'tool_call'
    )
      return undefined;
    // The tool-start title includes the server; the later permission title
    // contains only the tool name. The adapter remembers the earlier identity.
    const matches = [...names].filter((name) => toolCall.title?.startsWith(`${name}-`));
    return matches.length === 1 ? matches[0] : undefined;
  },
  // Do not authenticate (terminal login), enable autopilot, or pass --yolo.
  // Workflow modes are not permission levels. Switch answers each ACP request:
  // explicit approval/denial by default, allow_once under its full-access policy.
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
