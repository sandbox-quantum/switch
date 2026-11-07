import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import {
  ACP_CANCELLED,
  type AcpPermissionRequest,
  type AcpSessionModes,
  type AcpToolCall,
} from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import { readiness, SIGNED_OUT_ERROR } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

const QWEN_LOGIN = 'qwen';
const QWEN_SIGN_IN =
  'Sign in on the execution machine: run qwen and use /auth, or set OPENAI_API_KEY (with OPENAI_BASE_URL and OPENAI_MODEL when the provider is not OpenAI).';

// Qwen starts every session in `auto`, where its own classifier approves
// actions, so a session that must ask is never left in the mode it started in.
const QWEN_MODES: Record<RuntimeMode, string> = {
  'approval-required': 'default',
  'auto-accept-edits': 'auto-edit',
  auto: 'auto',
  'full-access': 'yolo',
};

function qwenSessionMode(runtimeMode: RuntimeMode, modes: AcpSessionModes | undefined): string {
  const id = QWEN_MODES[runtimeMode];
  if (!modes?.availableModes.some((mode) => mode.id === id))
    throw new Error(`This Qwen Code does not offer its ${id} mode, which ${runtimeMode} needs.`);
  return id;
}

interface QwenQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

function userQuestions(toolCall: AcpToolCall): QwenQuestion[] | undefined {
  if (toolCall._meta?.qwenInteractionKind !== 'user_question') return undefined;
  const questions = toolCall._meta.qwenQuestions;
  return Array.isArray(questions) ? (questions as QwenQuestion[]) : [];
}

/**
 * Qwen asks its questions as a permission request and takes the answers next
 * to the outcome, keyed by question number: an option label, custom text, or
 * a list of either for a multiple choice.
 */
function question(context: AcpSessionContext, questions: QwenQuestion[]): Promise<unknown> {
  if (!questions.length) return Promise.resolve(ACP_CANCELLED);
  return context.askQuestions(
    questions.map((q, index) => ({
      id: String(index),
      header: q.header,
      question: q.question,
      options: q.options.map((o) => ({ ...o, value: o.label })),
      multiSelect: q.multiSelect ?? false,
      allowCustomAnswer: true,
    })),
    (selected) => ({
      outcome: { outcome: 'selected', optionId: 'proceed_once' },
      answers: Object.fromEntries(
        selected.map(({ questionId, values, custom }) => [
          questionId,
          questions[Number(questionId)]?.multiSelect
            ? [...values, ...(custom ? [custom] : [])]
            : (custom ?? values[0]),
        ])
      ),
    })
  );
}

/**
 * Offers only what is safe to give a person. "Always Allow in project" and
 * "Always Allow for user" write a permanent rule to the project's or the
 * user's `.qwen/settings.json`, so they are dropped; "Allow All Edits" lasts
 * for the session and stays. Auto mode's "Switch to Default Mode" option is
 * dropped too: it changes the session's mode behind the runtime mode.
 */
function restateOptions(request: AcpPermissionRequest): void {
  let allowed = false;
  request.options = request.options.filter((option) => {
    if (/^proceed_always_(project|user)$/.test(option.optionId)) return false;
    if (option.kind !== 'allow_once') return true;
    if (allowed) return false;
    allowed = true;
    return true;
  });
}

/** Qwen Code's `qwen --acp`, on whichever model provider it is signed in to. */
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
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['--acp'], env }),
  loginCommand: QWEN_LOGIN,
  // Its handshake lists the same sign-in method whether or not one is set up,
  // so the check starts a session, which it refuses with "Authentication
  // required" when signed out. A session that starts is only in memory: Qwen
  // stores a conversation with its first prompt. A wrong key shows on the
  // first turn, not here.
  checkSignIn: async ({ cwd, handshake, request }) => {
    await handshake();
    try {
      await request('session/new', { cwd, mcpServers: [] });
    } catch (error) {
      if (error instanceof JsonRpcError && SIGNED_OUT_ERROR.test(error.message))
        return readiness('unauthenticated', QWEN_SIGN_IN);
      throw error;
    }
    return readiness('authenticated', 'Signed in.');
  },
  promptCapabilities: { image: true },
  sessionMode: qwenSessionMode,
  // Qwen reaches the session's MCP servers through its `tool_call` tool, so a
  // call is only named for its server by the permission request, in the tool's
  // `mcp__<server>__<tool>` name, and by the last update, in `serverId`.
  mcpServerOf: ({ _meta }) => {
    if (_meta?.provenance === 'mcp' && typeof _meta.serverId === 'string') return _meta.serverId;
    return typeof _meta?.toolName === 'string'
      ? /^mcp__(.+?)__/.exec(_meta.toolName)?.[1]
      : undefined;
  },
  // A subagent call is first announced as `tool_call` and named `agent` by
  // its next update.
  itemType: ({ _meta }) => (_meta?.toolName === 'agent' ? 'subagent' : undefined),
  permission: (context, request) => {
    const questions = userQuestions(request.toolCall);
    if (questions) return question(context, questions);
    restateOptions(request);
    return undefined;
  },
};

export function createQwenAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(qwenAcp, options);
}
