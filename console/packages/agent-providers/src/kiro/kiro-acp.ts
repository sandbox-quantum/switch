import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness, signInWith } from '../readiness';

export const KIRO_LOGIN = 'kiro-cli login';

/**
 * What `kiro-cli acp` answers every request but `initialize` with while it is
 * signed out: "Authentication required. Not logged in. …" (3.1.0).
 */
const SIGNED_OUT_ERROR = /authentication required|not logged in/i;

/**
 * Whether the agent the handshake started found a sign-in. Kiro reads its own
 * persisted sign-in (`kiro-cli login`, or `KIRO_API_KEY`) when it starts, and
 * while it has none it refuses everything after `initialize` with an
 * authentication error. `session/list` reads nothing and starts nothing, so it
 * asks without signing in; an agent that does not offer it is signed in.
 */
export async function kiroSignedIn(
  request: <T>(method: string, params: unknown) => Promise<T>
): Promise<boolean> {
  try {
    await request('session/list', {});
    return true;
  } catch (error) {
    if (SIGNED_OUT_ERROR.test(String(error))) return false;
    if (/method not found|-32601/i.test(String(error))) return true;
    throw error;
  }
}

interface KiroMcpTool {
  version?: unknown;
  identity?: { serverName?: unknown };
}

/**
 * The MCP server a tool call belongs to: CLI V3 names it, resolved by the
 * host, in `_meta.kiro.mcpTool` (version 1). Its annotations are untrusted
 * claims and are not read.
 */
export function kiroMcpServer(toolCall: Pick<AcpToolCall, '_meta'>): string | undefined {
  const kiro = toolCall._meta?.kiro as { mcpTool?: KiroMcpTool } | undefined;
  const mcpTool = kiro?.mcpTool;
  if (!mcpTool || mcpTool.version !== 1) return undefined;
  const server = mcpTool.identity?.serverName;
  return typeof server === 'string' && server ? server : undefined;
}

/** Read a versioned Kiro MCP identity, preserving invalid versus absent data. */
function kiroMetadataMcpServer(meta: unknown): string | null | undefined {
  if (meta === undefined) return undefined;
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return null;
  if (!Object.hasOwn(meta, 'kiro')) return undefined;
  const kiro = (meta as Record<string, unknown>).kiro;
  if (typeof kiro !== 'object' || kiro === null || Array.isArray(kiro)) return null;
  if (!Object.hasOwn(kiro, 'mcpTool')) return undefined;
  // A present but malformed or unknown-version identity must not fall back to
  // a cached update identity and accidentally bypass an approval.
  return kiroMcpServer({ _meta: meta as Record<string, unknown> }) ?? null;
}

/** Unknown explicit Kiro kinds are not evidence of a file operation. */
function kiroNonFileApprovalMetadata(meta: unknown): boolean {
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return false;
  if (!Object.hasOwn(meta, 'kiro')) return false;
  const kiro = (meta as Record<string, unknown>).kiro;
  if (typeof kiro !== 'object' || kiro === null || Array.isArray(kiro)) return true;
  return Object.hasOwn(kiro, 'kind');
}

/**
 * Kiro CLI over ACP, started on its V3 engine. Kiro signs itself in from the
 * sign-in `kiro-cli login` saved, or from `KIRO_API_KEY`, when it starts, so a
 * session sends no `authenticate`: Kiro's only method, `kiro-login`, just asks
 * the person to run `kiro-cli login` and reconnect. Models, modes and
 * extension methods are whatever the running agent advertises.
 */
export const kiroAcp: AcpProviderHooks = {
  provider: 'kiro',
  label: 'Kiro CLI',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  // CLI V3 is the engine that advertises its configuration and extensions;
  // Kiro asks ACP clients to choose it explicitly.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp', '--agent-engine=v3'],
    env,
  }),
  loginCommand: KIRO_LOGIN,
  // The API key Kiro signs in with headless, and where it keeps its sign-in
  // and sessions; a session has to read what the sign-in check read.
  inheritEnv: ['KIRO_API_KEY', 'XDG_DATA_HOME'],
  checkSignIn: async ({ handshake, request }) => {
    await handshake();
    return (await kiroSignedIn(request))
      ? readiness('authenticated', 'Signed in to Kiro.')
      : readiness('unauthenticated', signInWith(KIRO_LOGIN));
  },
  // Kiro's modes are agent configurations, not permission levels, so the
  // session keeps Kiro's default mode and the runtime mode is enforced on its
  // permission requests.
  mcpServerOf: (toolCall) => kiroMetadataMcpServer(toolCall._meta),
  // Kiro V3 also supplies the resolved identity on permission params.
  permissionMcpServerOf: (request) => kiroMetadataMcpServer(request._meta),
  // Kiro's allow_always persists a policy beyond this session, so it cannot
  // be represented by Switch's session-only approval decision.
  allowPermissionOption: (option) => option.kind !== 'allow_always',
  showApprovalFilePaths: true,
  nonFileApprovalMetadata: kiroNonFileApprovalMetadata,
  // The top-level task is a subagent; child tool calls carry agentSubtaskId
  // but are still ordinary tool calls of their own.
  itemType: (toolCall) => {
    const kiro = toolCall._meta?.kiro as { kind?: unknown } | undefined;
    return kiro?.kind === 'agent-subtask' ? 'subagent' : undefined;
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
