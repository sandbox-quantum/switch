import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { ItemType } from '../events';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const CURSOR_LOGIN = 'agent login';
const SIGNED_OUT = /not logged in|login required|authentication required/i;

/** Reads `agent about`, which names the signed-in account. */
export function parseCursorAbout(output: string): ProviderReadiness {
  if (
    /not logged in|not authenticated|login required|authentication required|not signed in/i.test(
      output
    )
  )
    return readiness('unauthenticated', signInWith(CURSOR_LOGIN));
  const email = output.match(/User Email(?:[ \t]*:[ \t]*|[ \t]+)(.+)/i)?.[1]?.trim();
  if (!email)
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  return SIGNED_OUT.test(email)
    ? readiness('unauthenticated', signInWith(CURSOR_LOGIN))
    : readiness('authenticated', 'Signed in.');
}

interface CursorQuestion {
  title?: string;
  questions: Array<{
    id: string;
    prompt: string;
    options: Array<{ id: string; label: string }>;
    allowMultiple?: boolean;
  }>;
}
interface CursorPlan {
  name?: string;
  plan: string;
}

function question(context: AcpSessionContext, params: CursorQuestion): Promise<unknown> {
  return context.askQuestions(
    params.questions.map((q) => ({
      id: q.id,
      header: params.title,
      question: q.prompt,
      options: q.options.map((o) => ({ label: o.label, value: o.id })),
      multiSelect: q.allowMultiple ?? false,
      allowCustomAnswer: false,
    })),
    (selected) => ({
      outcome: {
        outcome: 'answered',
        answers: selected.map(({ questionId, values }) => ({
          questionId,
          selectedOptionIds: values,
        })),
      },
    })
  );
}

function plan(context: AcpSessionContext, params: CursorPlan): Promise<unknown> {
  return context.requestDecision({
    requestType: 'tool_approval',
    title: params.name ?? 'Approve plan',
    detail: params.plan,
    options: [
      { decision: 'accept', label: 'Approve plan', response: { outcome: { outcome: 'accepted' } } },
      { decision: 'decline', label: 'Reject plan', response: { outcome: { outcome: 'rejected' } } },
      { decision: 'cancel', label: 'Cancel', response: { outcome: { outcome: 'cancelled' } } },
    ],
  });
}

function extensionItem(
  context: AcpSessionContext,
  title: string,
  params: unknown,
  type: ItemType
): void {
  const data = params as { toolCallId?: string; agentId?: string; description?: string };
  context.completeItem({
    id: data.toolCallId ?? randomUUID(),
    type,
    status: 'completed',
    title: data.description ?? title,
    text: JSON.stringify(params, null, 2),
    ...(data.agentId ? { nativeChildId: data.agentId } : {}),
  });
}

/** Cursor's `agent acp`, with its questions, plans, todos and subagent tasks. */
export const cursorAcp: AcpProviderHooks = {
  provider: 'cursor',
  label: 'Cursor CLI',
  defaultBinary: 'agent',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: CURSOR_LOGIN,
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      output = (
        await promisify(execFile)(binaryPath, ['about'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseCursorAbout(output);
  },
  authMethodId: 'cursor_login',
  promptCapabilities: { image: true },
  // Cursor's own modes are workflows (agent, plan, ask), not permission
  // levels, so the runtime mode is enforced on its permission requests.
  sessionMode: () => 'agent',
  mcpServerOf: (toolCall) => {
    const server = toolCall.rawInput?.providerIdentifier;
    return typeof server === 'string' && server ? server : undefined;
  },
  itemType: (toolCall) =>
    toolCall.rawInput?._toolName === 'task' || toolCall.title?.startsWith('Task:')
      ? 'subagent'
      : undefined,
  extensions: (context, on) => {
    for (const prefix of ['cursor/', '_cursor/']) {
      on.request(`${prefix}ask_question`, (params) => question(context, params as CursorQuestion));
      on.request(`${prefix}create_plan`, (params) => plan(context, params as CursorPlan));
      for (const [method, title, type] of [
        ['update_todos', 'Tasks', 'tool_call'],
        ['task', 'Subagent task', 'subagent'],
        ['generate_image', 'Generated image', 'tool_call'],
      ] as const) {
        on.notification(`${prefix}${method}`, (params) =>
          extensionItem(context, title, params, type)
        );
        on.request(`${prefix}${method}`, (params) => {
          extensionItem(context, title, params, type);
          return {};
        });
      }
    }
  },
};

export function createCursorAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(cursorAcp, options);
}
