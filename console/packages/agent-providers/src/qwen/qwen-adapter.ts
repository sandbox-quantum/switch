import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness } from '../readiness';

/**
 * What a signed-out Qwen Code needs. Over ACP it offers one sign-in, an
 * OpenAI-compatible key, and `qwen auth` is gone, so this is the whole of it.
 * Without OPENAI_BASE_URL the key goes to Alibaba Cloud's Model Studio, which
 * refuses any other provider's key as incorrect, so the endpoint is named too.
 */
export const QWEN_SIGN_IN =
  "Set OPENAI_API_KEY on this machine to an OpenAI-compatible key. Qwen Code sends it to Alibaba Cloud Model Studio unless OPENAI_BASE_URL names another provider's endpoint; set OPENAI_MODEL to choose the model.";

/** What Qwen says about a tool call in its `_meta`. */
interface QwenToolMeta {
  toolName?: unknown;
  provenance?: unknown;
  serverId?: unknown;
}

/** One question as Qwen's `ask_user_question` tool puts it in its input. */
interface QwenQuestion {
  question: string;
  header?: string;
  options?: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

/**
 * Qwen Code's `qwen --acp`, signed in with an OpenAI-compatible key.
 *
 * The key is read only when the agent is launched with `--auth-type=openai`;
 * without it Qwen answers `session/new` with "Authentication required". The
 * flag signs the session in from the environment, so no `authenticate` is
 * sent: sending it would also record the auth type in the person's own
 * `~/.qwen/settings.json`.
 */
export const qwenAcp: AcpProviderHooks = {
  provider: 'qwen',
  label: 'Qwen Code',
  defaultBinary: 'qwen',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: env.OPENAI_API_KEY ? ['--acp', '--auth-type=openai'] : ['--acp'],
    env,
  }),
  loginCommand: 'export OPENAI_API_KEY=<your Model Studio or other OpenAI-compatible key>',
  inheritEnv: ['OPENAI_BASE_URL', 'OPENAI_MODEL'],
  // The key is the sign-in, so its presence is the answer; asking the agent
  // would mean starting a session.
  checkSignIn: async ({ env }) =>
    env.OPENAI_API_KEY
      ? readiness('authenticated', 'Qwen Code is signed in with OPENAI_API_KEY.')
      : readiness('unauthenticated', QWEN_SIGN_IN),
  // A session starts in Qwen's own `auto` whatever was asked for, so every
  // runtime mode is set explicitly. `auto` is Qwen's own reviewer: safe
  // actions run, risky ones still ask.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'yolo';
      case 'auto':
        return 'auto';
      case 'auto-accept-edits':
        return 'auto-edit';
      case 'approval-required':
        return 'default';
    }
  },
  // ACP has no kind for an agent, so Qwen names every call's tool in `_meta`.
  // A deferred tool, the agent among them, is reached through `tool_call`,
  // whose input names it; that input arrives in a later update than the call.
  itemType: (toolCall) => {
    const meta = toolCall._meta as QwenToolMeta | undefined;
    const input = toolCall.rawInput as { name?: unknown } | undefined;
    return meta?.toolName === 'agent' || (meta?.toolName === 'tool_call' && input?.name === 'agent')
      ? 'subagent'
      : undefined;
  },
  mcpServerOf: (toolCall) => qwenMcpServer(toolCall),
  // Qwen asks its `ask_user_question` questions as a permission request whose
  // tool input holds them, and takes the answers beside the chosen option,
  // keyed by each question's index, as Qwen's own clients send them. It adds
  // an "Other" choice itself, so a typed answer is always allowed.
  permission: (context, { toolCall }) => {
    const questions = (toolCall.rawInput as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(questions)) return undefined;
    return context.askQuestions(
      (questions as QwenQuestion[]).map((question, index) => ({
        id: String(index),
        ...(question.header ? { header: question.header } : {}),
        question: question.question,
        options: (question.options ?? []).map((option) => ({
          label: option.label,
          ...(option.description ? { description: option.description } : {}),
          value: option.label,
        })),
        multiSelect: question.multiSelect === true,
        allowCustomAnswer: true,
      })),
      (selected) => ({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
        answers: Object.fromEntries(
          selected.map((answer) => [answer.questionId, answer.values.join(', ')])
        ),
      })
    );
  },
};

/**
 * The MCP server a Qwen tool call belongs to. A tool call's own update says so
 * (`provenance: 'mcp'`, `serverId`), but a permission request names only the
 * tool, `mcp__<server>__<tool>`, split on `__` as Qwen splits it; reading a
 * server's resource names the server in its input instead. Qwen reaches all of
 * these through `tool_call`, whose request is the underlying tool's.
 */
function qwenMcpServer(toolCall: AcpToolCall): string | undefined {
  const meta = toolCall._meta as QwenToolMeta | undefined;
  if (meta?.provenance === 'mcp' && typeof meta.serverId === 'string') return meta.serverId;
  if (typeof meta?.toolName !== 'string') return undefined;
  const [prefix, server, ...tool] = meta.toolName.split('__');
  if (prefix === 'mcp' && server && tool.length) return server;
  const input = toolCall.rawInput as { server_name?: unknown } | undefined;
  return meta.toolName === 'read_mcp_resource' && typeof input?.server_name === 'string'
    ? input.server_name
    : undefined;
}

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
