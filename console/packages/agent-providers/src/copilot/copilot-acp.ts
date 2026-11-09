import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSignInInput } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

export const COPILOT_LOGIN = 'copilot login';

/**
 * Copilot's own token variable, which it reads ahead of `GH_TOKEN`,
 * `GITHUB_TOKEN` and any saved login. Only this one is passed to sessions (see
 * `inheritEnv`), so only this one settles the check without asking the CLI.
 */
const TOKEN_VAR = 'COPILOT_GITHUB_TOKEN';

/** A bring-your-own-key model provider, which Copilot runs on without GitHub. */
const BYOK_VARS = ['COPILOT_PROVIDER_BASE_URL', 'COPILOT_PROVIDERS_CONFIG'] as const;

/**
 * Whether the environment alone signs Copilot in: a bring-your-own-key model
 * provider needs no GitHub sign-in, and a token in the environment is used
 * ahead of any saved login. Undefined when the environment says nothing and
 * the CLI has to be asked. A token is taken as given, as Cursor's key is;
 * checking it would spend a request.
 */
export function copilotEnvSignIn(env: Record<string, string>): ProviderReadiness | undefined {
  const byok = BYOK_VARS.find((key) => env[key]?.trim());
  if (byok)
    return readiness(
      'authenticated',
      `Uses the model provider in ${byok}; no GitHub sign-in is needed.`
    );
  const token = env[TOKEN_VAR]?.trim();
  if (!token) return undefined;
  // Classic personal access tokens are refused by Copilot CLI, so a session
  // with one would fail on its first turn rather than at the check.
  return token.startsWith('ghp_')
    ? readiness(
        'unauthenticated',
        `${TOKEN_VAR} holds a classic personal access token, which Copilot CLI does not accept. Use a fine-grained token with the Copilot Requests permission, or unset it and sign in with ${COPILOT_LOGIN}.`
      )
    : readiness('authenticated', `Signs in with the GitHub token in ${TOKEN_VAR}.`);
}

/**
 * Asks the CLI itself. `initialize` answers whether or not it is signed in,
 * but `session/new` is refused with "Authentication required" when it is not,
 * so a session is opened (and closed straight away) to tell. That covers a
 * login kept in the system keychain or in `~/.copilot`, and the `gh` fallback,
 * without sending `authenticate`, whose only method is the interactive
 * `copilot login`.
 */
async function askCopilot({ cwd, handshake, request }: AcpSignInInput): Promise<ProviderReadiness> {
  const init = await handshake();
  let sessionId: string;
  try {
    ({ sessionId } = await request<{ sessionId: string }>('session/new', {
      cwd,
      mcpServers: [],
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /auth|log ?in|sign ?in/i.test(message)
      ? readiness('unauthenticated', signInWith(COPILOT_LOGIN))
      : readiness(
          'unknown',
          `Copilot CLI could not open a session (${message}). If sessions fail, sign in with ${COPILOT_LOGIN}.`
        );
  }
  // Copilot 1.0.107 offers `session/close`; the probe session is not kept open.
  const sessions = init.agentCapabilities?.sessionCapabilities as { close?: unknown } | undefined;
  if (sessions?.close) await request('session/close', { sessionId }).catch(() => undefined);
  return readiness('authenticated', 'Signed in.');
}

/**
 * Copilot titles an MCP tool call `<server>-<tool>` in its `tool_call` update,
 * then asks permission for the same call titled with the bare `<tool>`. The
 * server is what is left of the first title once `-<tool>` is taken off, which
 * stays exact for server names that hold a hyphen themselves. The update's
 * title is kept per tool call until the permission request for it arrives.
 */
const mcpTitles = new Map<string, string>();
const MAX_MCP_TITLES = 256;

function copilotMcpServerOf(toolCall: AcpToolCall): string | undefined {
  const { toolCallId, title } = toolCall;
  if (!title) return undefined;
  const seen = mcpTitles.get(toolCallId);
  if (seen === undefined || seen === title) {
    // A tool call's first sighting; remember its title for the permission request.
    if (seen === undefined && !/\s/.test(title) && title.includes('-')) {
      if (mcpTitles.size >= MAX_MCP_TITLES) mcpTitles.delete(mcpTitles.keys().next().value!);
      mcpTitles.set(toolCallId, title);
    }
    return undefined;
  }
  mcpTitles.delete(toolCallId);
  const suffix = `-${title}`;
  return seen.endsWith(suffix) && seen.length > suffix.length
    ? seen.slice(0, -suffix.length)
    : undefined;
}

/**
 * GitHub Copilot CLI's ACP server, `copilot --acp --stdio` (public preview).
 * Copilot has no permission modes over ACP and `--yolo` is not honoured
 * there, so the generic adapter answers its permission requests for the
 * runtime mode. Models come from the session and are chosen per session.
 */
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
  // Copilot's ACP server takes MCP servers over HTTP and SSE only; a stdio
  // server in `session/new` is dropped with a log line and nothing else.
  mcpServerOf: copilotMcpServerOf,
  // Copilot's `task` tool reaches ACP as a plain `other` call; its input names
  // the agent it starts (`agent_type`) and the prompt it hands that agent.
  itemType: (toolCall) =>
    typeof toolCall.rawInput?.agent_type === 'string' &&
    typeof toolCall.rawInput?.prompt === 'string'
      ? 'subagent'
      : undefined,
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp', '--stdio'], env }),
  loginCommand: COPILOT_LOGIN,
  // Copilot 1.0.107 reports a missing native session this way on session/load.
  // Other missing resources and errors from other requests must stay ordinary failures.
  sessionLoadUnavailable: (error, nativeSessionId) =>
    error instanceof JsonRpcError &&
    error.code === -32002 &&
    error.message === `Resource not found: Session ${nativeSessionId} not found`,
  // Copilot's own token, its home, and its bring-your-own-key provider. GH_TOKEN
  // and GITHUB_TOKEN are not passed through: they would reach every agent, and
  // they override a saved `copilot login`. The sign-in check asks the CLI about
  // them like any other login it finds itself.
  inheritEnv: [
    'COPILOT_GITHUB_TOKEN',
    'COPILOT_HOME',
    'COPILOT_GH_HOST',
    'COPILOT_OFFLINE',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_TYPE',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BEARER_TOKEN',
    'COPILOT_PROVIDER_WIRE_API',
    'COPILOT_PROVIDER_MODEL_ID',
    'COPILOT_PROVIDER_WIRE_MODEL',
    'COPILOT_PROVIDERS_CONFIG',
  ],
  checkSignIn: async (input) => copilotEnvSignIn(input.env) ?? (await askCopilot(input)),
};

export function createCopilotAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(copilotAcp, options);
}
