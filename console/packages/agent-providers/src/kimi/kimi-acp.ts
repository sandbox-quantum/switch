import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpLaunchInput, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness, signInWith, type ProviderReadiness } from '../readiness';
import { JsonRpcError, noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

const KIMI_LOGIN = 'kimi login';
const UNVERIFIED = 'Could not verify authentication. Check provider setup and try again.';
/** A session id Kimi never mints (its own are `session_<uuid>`), so resuming it opens nothing. */
const SIGN_IN_PROBE_SESSION = 'switch-sign-in-check';
/** ACP's `auth_required` and `invalid_params` error codes. */
const AUTH_REQUIRED = -32000;
const INVALID_PARAMS = -32602;
/** How Kimi names a tool on an MCP server: `mcp__<server>__<tool>`, where the server part has no `__`. */
const MCP_TOOL = /^mcp__(.+?)__/;
const SUBAGENT_TOOLS = new Set(['Agent', 'AgentSwarm']);
const SUBAGENT_TITLE = /^Launching (?:background )?(?:.+ agent|agent swarm): /;
/** The answer options Kimi offers when it asks a question over `session/request_permission`. */
const QUESTION_OPTION = /^q\d+_opt_\d+$/;

/**
 * Reads how `kimi acp` answers `session/resume` for a session that does not
 * exist. It checks its credentials (an OAuth sign-in, a configured API key or
 * the `KIMI_MODEL_*` variables) before it looks for the session, so
 * `auth_required` means signed out and an unknown session means signed in.
 */
export function parseKimiResumeProbe(error: unknown): ProviderReadiness {
  if (!(error instanceof JsonRpcError)) return readiness('unknown', UNVERIFIED);
  if (error.code === AUTH_REQUIRED) return readiness('unauthenticated', signInWith(KIMI_LOGIN));
  if (error.code === INVALID_PARAMS && /unknown session/i.test(error.message))
    return readiness('authenticated', 'Signed in to Kimi Code.');
  return readiness('unknown', UNVERIFIED);
}

function launch({ binaryPath, env }: Pick<AcpLaunchInput, 'binaryPath' | 'env'>) {
  return { command: binaryPath, args: ['acp'], env };
}

function textOf(toolCall: AcpToolCall): string | undefined {
  return toolCall.content?.find((part) => part.content?.text)?.content?.text;
}

/** Kimi Code CLI's `kimi acp`, whose questions arrive as permission requests. */
export const kimiAcp: AcpProviderHooks = {
  provider: 'kimi',
  label: 'Kimi Code CLI',
  defaultBinary: 'kimi',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch,
  loginCommand: KIMI_LOGIN,
  // Kimi reads its credentials from its own data root (`KIMI_CODE_HOME`,
  // `~/.kimi-code` by default) and, without one, from the `KIMI_MODEL_*`
  // variables; a provider key is never read from the shell unless its
  // config names the variable.
  inheritEnv: [
    'KIMI_CODE_HOME',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_BASE_URL',
    'KIMI_SHELL_PATH',
  ],
  // `initialize` lists the `login` method whether or not the CLI is signed
  // in, and `authenticate` would start a device-code sign-in, so the check
  // asks Kimi's own credential gate instead: `session/resume` of a session
  // that does not exist, which opens and writes nothing.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    const client = new StdioJsonRpcClient({
      ...launch({ binaryPath, env }),
      cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await acpInitialize(client, kimiAcp);
      await client.request('session/resume', {
        sessionId: SIGN_IN_PROBE_SESSION,
        cwd,
        mcpServers: [],
      });
      return readiness('unknown', UNVERIFIED);
    } catch (error) {
      return parseKimiResumeProbe(error);
    } finally {
      await client.dispose();
    }
  },
  // Kimi's modes are permission levels. `yolo` is its own review: routine
  // commands and edits run, while dangerous commands, sensitive files and
  // .git internals still ask. Its `auto` approves everything and refuses
  // questions, so full access stays on `yolo` and the adapter answers what
  // is left.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
      case 'auto':
        return 'yolo';
      case 'auto-accept-edits':
      case 'approval-required':
        return 'default';
    }
  },
  mcpServerOf: (toolCall) => toolCall.title?.match(MCP_TOOL)?.[1],
  itemType: (toolCall) =>
    SUBAGENT_TOOLS.has(toolCall.title ?? '') || SUBAGENT_TITLE.test(toolCall.title ?? '')
      ? 'subagent'
      : undefined,
  // Without an elicitation form, Kimi asks AskUserQuestion's question as a
  // permission request: one allow-once option per answer, plus a skip.
  permission: (context, { toolCall, options }) => {
    const answers = options.filter((option) => QUESTION_OPTION.test(option.optionId));
    if (!answers.length) return undefined;
    return context.askQuestions(
      [
        {
          id: toolCall.toolCallId,
          question: textOf(toolCall) ?? 'Choose an option.',
          options: answers.map((option) => ({ value: option.optionId, label: option.name })),
          multiSelect: false,
          allowCustomAnswer: false,
        },
      ],
      ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
    );
  },
};

export function createKimiAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kimiAcp, options);
}
