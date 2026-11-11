import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpInitializeResult, AcpPermissionRequest, AcpToolCall } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const KIRO_LOGIN = 'kiro-cli login';

export const KIRO_SIGN_IN = `${signInWith(KIRO_LOGIN)} On a machine without a browser, run kiro-cli login --use-device-flow, or give the agent a KIRO_API_KEY.`;

/**
 * The only auth method a signed-out `kiro-cli acp` advertises. With no login
 * and no `KIRO_API_KEY` the CLI answers `initialize` itself with this method
 * and refuses `session/new`, whichever agent engine is configured.
 */
export const KIRO_SIGNED_OUT_AUTH_METHOD = 'kiro-login';

/** What Kiro puts under `_meta.kiro` on a permission request or a tool call. */
export interface KiroMeta {
  toolId?: unknown;
  command?: unknown;
  kind?: unknown;
  serverName?: unknown;
  mcpTool?: { identity?: { serverName?: unknown } };
}

function kiroMeta(meta: unknown): KiroMeta | undefined {
  if (typeof meta !== 'object' || meta === null) return undefined;
  const kiro = (meta as { kiro?: unknown }).kiro;
  return typeof kiro === 'object' && kiro !== null ? (kiro as KiroMeta) : undefined;
}

const SIGNED_IN = 'Signed in to Kiro CLI.';
const SIGNED_IN_WITH_KEY = 'Signs in with the Kiro API key it was given.';

/**
 * Reads `kiro-cli whoami --format json`. Signed out it prints
 * `{"account":null}` and exits 1; signed in it names the account type
 * (`{"accountType":"ApiKey",…}` with a `KIRO_API_KEY`). Anything it cannot
 * read for certain is undefined, so the caller asks the agent instead of
 * guessing. Account details are never passed on.
 */
export function parseKiroWhoami(output: string): ProviderReadiness | undefined {
  const text = output.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (/not logged in/i.test(text)) return readiness('unauthenticated', KIRO_SIGN_IN);
    if (/^logged in with/im.test(text)) return readiness('authenticated', SIGNED_IN);
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { accountType } = parsed as { accountType?: unknown };
  if (typeof accountType === 'string' && accountType)
    return readiness('authenticated', accountType === 'ApiKey' ? SIGNED_IN_WITH_KEY : SIGNED_IN);
  if ('account' in parsed)
    return parsed.account
      ? readiness('authenticated', SIGNED_IN)
      : readiness('unauthenticated', KIRO_SIGN_IN);
  return undefined;
}

/** Reads the `initialize` answer: signed out, Kiro offers only its `kiro-login` method. */
export function kiroHandshakeReadiness(
  initialized: AcpInitializeResult,
  env: Record<string, string>
): ProviderReadiness {
  if (initialized.authMethods?.some((method) => method.id === KIRO_SIGNED_OUT_AUTH_METHOD))
    return readiness('unauthenticated', KIRO_SIGN_IN);
  return readiness('authenticated', env.KIRO_API_KEY?.trim() ? SIGNED_IN_WITH_KEY : SIGNED_IN);
}

const EDIT_TOOLS = new Set([
  'write',
  'append',
  'replace',
  'create',
  'edit_code',
  'editCode',
  'fs_write',
  'fsWrite',
  'fs_append',
  'str_replace',
]);
const EXECUTE_TOOLS = new Set(['run_command', 'runCommand', 'control_process', 'controlProcess']);

/** The ACP kind of the tool a Kiro permission request is for, from the tool it names. */
export function kiroPermissionKind(meta: KiroMeta): string | undefined {
  if (typeof meta.command === 'string' && meta.command) return 'execute';
  if (typeof meta.toolId !== 'string') return undefined;
  if (EXECUTE_TOOLS.has(meta.toolId)) return 'execute';
  if (EDIT_TOOLS.has(meta.toolId)) return 'edit';
  return undefined;
}

function mcpServerOf(toolCall: AcpToolCall): string | undefined {
  const meta = kiroMeta(toolCall._meta);
  const server = meta?.mcpTool?.identity?.serverName ?? meta?.serverName;
  return typeof server === 'string' && server ? server : undefined;
}

/**
 * A question Kiro asks through a permission request, which it does for a
 * client that has not declared Kiro's own question method: every option is an
 * `allow_once` carrying one answer, and the request names no tool.
 */
function isQuestion(request: AcpPermissionRequest & { _meta?: unknown }): boolean {
  return (
    request.options.length > 0 &&
    request.options.every((option) => option.kind === 'allow_once') &&
    kiroMeta(request._meta)?.toolId === undefined
  );
}

function question(context: AcpSessionContext, request: AcpPermissionRequest): Promise<unknown> {
  const { toolCall, options } = request;
  return context.askQuestions(
    [
      {
        id: toolCall.toolCallId,
        question: toolCall.title ?? 'Choose an option.',
        options: options.map((option) => ({ value: option.optionId, label: option.name })),
        multiSelect: false,
        allowCustomAnswer: false,
      },
    ],
    ([selected]) => ({ outcome: { outcome: 'selected', optionId: selected!.values[0] } })
  );
}

/** Kiro CLI's `kiro-cli acp`, on whichever agent engine Kiro picks for it. */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: true,
  },
  // No engine, agent, model or trust flags: the V3 engine refuses the V2
  // ones, and Kiro picks the engine itself (V3 for a client it recognises,
  // Switch Console among them, else its `acp.agentEngine` setting). What the
  // session can do is read from the handshake.
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: KIRO_LOGIN,
  inheritEnv: ['KIRO_API_KEY'],
  // `whoami` reads the login without touching it. A key in the environment,
  // or an answer it cannot read, is settled by the handshake, which a
  // signed-out CLI answers with its `kiro-login` method. Neither sends
  // `authenticate`.
  checkSignIn: async ({ binaryPath, cwd, env, handshake }) => {
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['whoami', '--format', 'json'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    const whoami = parseKiroWhoami(output);
    if (whoami?.status === 'authenticated') return whoami;
    if (whoami && !env.KIRO_API_KEY?.trim()) return whoami;
    return kiroHandshakeReadiness(await handshake(), env);
  },
  // Kiro's modes (vibe, spec, plan…) are workflows, not permission levels, so
  // the session keeps the agent the person configured and the runtime mode is
  // applied to its permission requests.
  mcpServerOf,
  itemType: (toolCall) =>
    kiroMeta(toolCall._meta)?.kind === 'agent-subtask' ? 'subagent' : undefined,
  permission: (context, request) => {
    if (isQuestion(request)) return question(context, request);
    // Kiro names the tool under the request's `_meta.kiro` and leaves the ACP
    // kind and MCP server off the tool call, where the adapter reads them to
    // type the approval, accept edits in auto-accept-edits and let the
    // session's own MCP servers through.
    const meta = kiroMeta((request as { _meta?: unknown })._meta);
    if (!meta) return undefined;
    const { toolCall } = request;
    toolCall.kind ??= kiroPermissionKind(meta);
    if (meta.mcpTool && !mcpServerOf(toolCall))
      toolCall._meta = {
        ...toolCall._meta,
        kiro: { ...kiroMeta(toolCall._meta), mcpTool: meta.mcpTool },
      };
    return undefined;
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
