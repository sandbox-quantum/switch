import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import {
  elicitationAnswer,
  elicitationQuestions,
  FORM_ELICITATION_CAPABILITIES,
  type AcpElicitationRequest,
} from '../acp/elicitation';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import { ACP_CANCELLED, type AcpToolCall } from '../acp/protocol';
import type { UserInputQuestion } from '../events';
import { readiness, signInWith } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

const KIMI_LOGIN = 'kimi login';
// ACP's `auth_required`, which Kimi answers `session/new` with when signed out.
const AUTH_REQUIRED = -32000;

// What Kimi's tools do, as its ACP server names them (`inferToolKind`).
const TOOL_KINDS = new Map([
  ['Write', 'edit'],
  ['Edit', 'edit'],
  ['Bash', 'execute'],
  ['Terminal', 'execute'],
]);

// The option ids Kimi gives a question it asks as a permission request
// (`q<question>_opt_<option>`, and `q<question>_skip` to dismiss it).
const QUESTION_OPTION = /^q\d+_(?:opt_\d+|skip)$/;
const SKIP_OPTION = /^q\d+_skip$/;
// How Kimi titles its `Agent` and `AgentSwarm` calls once their input is in.
const LAUNCH_TITLE = /^Launching (?:background )?(?:\S+ agent|agent swarm): /;

/**
 * Whether a tool call is Kimi's `Agent` or `AgentSwarm` tool. It opens titled
 * by the tool's name with no input yet; its input (a prompt and a subagent
 * type, or a resume id) follows, and the title becomes its launch line.
 */
function isSubagent(toolCall: AcpToolCall): boolean {
  const title = toolCall.title ?? '';
  const input = toolCall.rawInput;
  return (
    title === 'Agent' ||
    title === 'AgentSwarm' ||
    LAUNCH_TITLE.test(title) ||
    (typeof input?.prompt === 'string' &&
      (typeof input.subagent_type === 'string' || typeof input.resume === 'string'))
  );
}

/** A name as Kimi writes it into a tool name (its `sanitizeMcpNamePart`). */
function kimiNamePart(name: string): string {
  return name.replaceAll(/[^a-zA-Z0-9_-]/g, '_').replaceAll(/_+/g, '_');
}

/**
 * The MCP server a Kimi tool name (`mcp__<server>__<tool>`) belongs to. Kimi
 * replaces each character of a name other than a letter, digit, `_` or `-`
 * by `_` and folds runs of `_` to one, so the first `__` ends the server's
 * name. A session's server is matched by its name as Kimi writes it, and
 * named as the session registered it.
 */
export function kimiMcpServer(
  title: string | undefined,
  servers: ReadonlySet<string>
): string | undefined {
  const written = /^mcp__(.+?)__/.exec(title ?? '')?.[1];
  if (!written) return undefined;
  return [...servers].find((server) => kimiNamePart(server) === written) ?? written;
}

/**
 * The questions of Kimi's form. Kimi titles each field with the question's
 * short header (the question's own text where it has none) and puts the
 * questions in the form's message, one a line, so each is asked by its text
 * with its header beside it.
 */
export function kimiQuestions(request: AcpElicitationRequest): UserInputQuestion[] {
  const questions = elicitationQuestions(request);
  const lines = request.message?.split('\n') ?? [];
  // A question that breaks its own lines leaves the lines unmatched.
  const texts =
    lines.length === questions.length ? lines : questions.length === 1 ? [request.message] : [];
  return questions.map((question, index) => {
    const header = request.requestedSchema?.properties?.[question.id]?.title?.trim() || undefined;
    const text = texts[index]?.trim() || header || question.question;
    const { header: _generic, ...rest } = question;
    return { ...rest, question: text, ...(header && header !== text ? { header } : {}) };
  });
}

/** Kimi Code CLI's `kimi acp`. */

export const kimiAcp: AcpProviderHooks = {
  provider: 'kimi',
  label: 'Kimi Code',
  defaultBinary: 'kimi',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // A session host has nobody to answer an update prompt. Kimi saves its
  // sessions as it closes, once its input ends; `kimi acp` handles no
  // SIGTERM, so a signal would end it before the last turn is saved.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env: { ...env, KIMI_CODE_NO_AUTO_UPDATE: '1' },
    exitsOnClosedInput: true,
  }),
  loginCommand: KIMI_LOGIN,
  // `KIMI_MODEL_*` runs Kimi on a model of the machine's choosing, with its key.
  inheritEnv: [
    'KIMI_CODE_HOME',
    'KIMI_SHELL_PATH',
    'KIMI_MODEL_NAME',
    'KIMI_MODEL_API_KEY',
    'KIMI_MODEL_BASE_URL',
    'KIMI_MODEL_PROVIDER_TYPE',
    'KIMI_MODEL_MAX_CONTEXT_SIZE',
    'KIMI_MODEL_MAX_OUTPUT_SIZE',
    'KIMI_MODEL_CAPABILITIES',
    'KIMI_MODEL_DISPLAY_NAME',
  ],
  // Kimi lists its login method in every `initialize`, so the handshake cannot
  // tell. Its own readiness check runs on `session/new`: a session is opened in
  // an empty directory and deleted again. Nothing signs in and no model is called.
  checkSignIn: async ({ handshake, request }) => {
    const cwd = await mkdtemp(join(tmpdir(), 'switch-kimi-'));
    try {
      await handshake();
      let sessionId: string;
      try {
        ({ sessionId } = await request<{ sessionId: string }>('session/new', {
          cwd,
          mcpServers: [],
        }));
      } catch (error) {
        if (error instanceof JsonRpcError && error.code === AUTH_REQUIRED)
          return readiness('unauthenticated', signInWith(KIMI_LOGIN));
        throw error;
      }
      await request('session/delete', { sessionId });
      return readiness('authenticated', 'Signed in to Kimi Code.');
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  // Kimi has no edits-only mode, so auto-accept-edits stays in `default` and
  // Switch allows the edits. Kimi's `yolo` approves its tools but still asks
  // before a dangerous command, which is Switch's auto; in full access the
  // adapter approves those too. Kimi's own `auto` is for when nobody is there:
  // it approves everything and refuses its questions, so it is never used.
  sessionMode: (mode) =>
    mode === 'approval-required' || mode === 'auto-accept-edits' ? 'default' : 'yolo',
  // Kimi asks all of an AskUserQuestion's questions in one form when the
  // client can answer forms, every choice of a multi-select one included.
  clientCapabilities: FORM_ELICITATION_CAPABILITIES,
  extensions: (context, on) => {
    on.request('elicitation/create', async (params) => {
      const request = params as AcpElicitationRequest;
      const questions = kimiQuestions(request);
      if (!questions.length) return { action: 'decline' };
      const result = await context.askQuestions(questions, (selected) =>
        elicitationAnswer(request, selected)
      );
      return result === ACP_CANCELLED ? { action: 'cancel' } : result;
    });
  },
  // A permission request carries the bare tool name as its title.
  mcpServerOf: (toolCall, servers) => kimiMcpServer(toolCall.title, servers),
  itemType: (toolCall) => (isSubagent(toolCall) ? 'subagent' : undefined),
  permission: (context, { toolCall, options }) => {
    // Where a form cannot be asked, Kimi asks the first question alone as a
    // permission request, its choices as options and "Skip" to dismiss it.
    if (options.length && options.every((option) => QUESTION_OPTION.test(option.optionId))) {
      const choices = options.filter((option) => !SKIP_OPTION.test(option.optionId));
      if (!choices.length) return Promise.resolve(ACP_CANCELLED);
      const question =
        (Array.isArray(toolCall.content) ? toolCall.content : [])
          .map((part) => part.content?.text ?? '')
          .find((text) => text.trim()) ??
        toolCall.title ??
        'Choose an option.';
      return context.askQuestions(
        [
          {
            id: toolCall.toolCallId,
            question,
            options: choices.map((option) => ({ value: option.optionId, label: option.name })),
            multiSelect: false,
            allowCustomAnswer: false,
          },
        ],
        ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
      );
    }
    // Kimi's permission requests carry no ACP kind, which edits and approval
    // cards are told apart by, so it is given from the tool's name.
    const kind = TOOL_KINDS.get(toolCall.title ?? '');
    if (kind && !toolCall.kind) toolCall.kind = kind;
    return undefined;
  },
};

export function createKimiAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kimiAcp, options);
}
