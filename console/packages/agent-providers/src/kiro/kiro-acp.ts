import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
  signInWith,
  type ProviderReadiness,
  type SignInCheckInput,
} from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

export const KIRO_LOGIN = 'kiro-cli login';
export const KIRO_LOGIN_HINT = `Sign in on the execution machine with ${KIRO_LOGIN} (use \`${KIRO_LOGIN} --use-device-flow\` in SSH or headless environments).`;

const SIGNED_OUT_PATTERN =
  /not logged in|not authenticated|login required|authentication required|not signed in|unauthenticated|please log in|session expired|no active credentials/i;

export interface KiroExtensionMeta {
  extensionMethods?: string[];
  [key: string]: unknown;
}

export interface KiroAgentCapabilities {
  _meta?: {
    kiro?: KiroExtensionMeta;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function recordField(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return field && typeof field === 'object' ? (field as Record<string, unknown>) : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : undefined;
}

/**
 * Parses output from `kiro-cli whoami --format json` (or plaintext status messages)
 * to determine provider authentication state without prompting interactively.
 * Handles the real CLI shapes:
 * - Signed out JSON: `{"account":null}`
 * - Signed in Builder ID JSON: `{"accountType":"BuilderId",...,"email":"dev@example.com"}`
 * - Signed in nested account JSON: `{"account":{"email":"dev@example.com",...}}`
 * - Plain text: "Logged in with Builder ID", "Email: ...", or "Error: Not logged in..."
 */
export function parseKiroWhoami(output: string): ProviderReadiness {
  const trimmed = output.trim();
  if (!trimmed) {
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof data === 'object' && data !== null) {
      // Direct null account indicates signed out
      if ('account' in data) {
        if (data.account === null) {
          return readiness('unauthenticated', KIRO_LOGIN_HINT);
        }
        if (data.account && typeof data.account === 'object') {
          const account = data.account as Record<string, unknown>;
          const user =
            (typeof account.email === 'string' && account.email) ||
            (typeof account.user === 'string' && account.user) ||
            (typeof account.username === 'string' && account.username);
          return readiness(
            'authenticated',
            user ? `Signed in to Kiro CLI as ${user}.` : 'Signed in to Kiro CLI.'
          );
        }
      }

      if (
        data.authenticated === false ||
        data.status === 'unauthenticated' ||
        data.status === 'logged_out' ||
        data.loggedIn === false
      ) {
        return readiness('unauthenticated', KIRO_LOGIN_HINT);
      }

      if (
        data.authenticated === true ||
        data.status === 'authenticated' ||
        data.status === 'active' ||
        data.loggedIn === true
      ) {
        const user =
          (typeof data.email === 'string' && data.email) ||
          (typeof data.user === 'string' && data.user) ||
          (typeof data.username === 'string' && data.username);
        return readiness(
          'authenticated',
          user ? `Signed in to Kiro CLI as ${user}.` : 'Signed in to Kiro CLI.'
        );
      }

      const email = typeof data.email === 'string' && data.email.length > 0 ? data.email : undefined;
      const user =
        email ||
        (typeof data.user === 'string' && data.user) ||
        (typeof data.username === 'string' && data.username);
      if (user) {
        return readiness('authenticated', `Signed in to Kiro CLI as ${user}.`);
      }

      return readiness(
        'unknown',
        'Could not verify authentication. Check provider setup and try again.'
      );
    }
  } catch {
    // Not valid JSON; fall through to plaintext parsing
  }

  if (SIGNED_OUT_PATTERN.test(trimmed)) {
    return readiness('unauthenticated', KIRO_LOGIN_HINT);
  }

  const emailMatch = trimmed.match(/Email(?:[ \t]*:[ \t]*|[ \t]+)(.+)/i)?.[1]?.trim();
  if (/logged in with/i.test(trimmed) || emailMatch) {
    return readiness(
      'authenticated',
      emailMatch ? `Signed in to Kiro CLI as ${emailMatch}.` : 'Signed in to Kiro CLI.'
    );
  }

  return readiness(
    'unknown',
    'Could not verify authentication. Check provider setup and try again.'
  );
}

export async function checkKiroSignIn(input: SignInCheckInput): Promise<ProviderReadiness> {
  let output: string;
  try {
    const res = await execProvider(input.binaryPath, ['whoami', '--format', 'json'], {
      cwd: input.cwd,
      env: input.env,
      timeout: 15000,
      maxBuffer: 1024 * 1024,
    });
    output = res.stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: unknown; stderr?: unknown };
    if (err.code === 'ENOENT' || /not found|not recognized|no such file/i.test(err.message ?? '')) {
      return readiness(
        'unconfigured',
        `Kiro CLI is not installed or not found on PATH: ${input.binaryPath}.`
      );
    }
    output = commandOutput(error);
    if (!output && typeof err.stderr === 'string') {
      output = err.stderr;
    }
  }
  return parseKiroWhoami(output);
}

/**
 * The MCP server a Kiro tool call belongs to.
 * Checks _meta.kiro (mcpTool identity or serverName), namespaced rawInput tool_id (<server>::<tool>),
 * @server/tool titles, and standard fallback fields.
 */
export function kiroMcpServerOf(toolCall: AcpToolCall): string | undefined {
  const kiro = recordField(toolCall._meta, 'kiro');
  const identity = recordField(recordField(kiro, 'mcpTool'), 'identity');
  const fromMeta =
    stringField(identity, 'serverName') ??
    stringField(kiro, 'serverName') ??
    stringField(kiro, 'server');
  if (fromMeta) return fromMeta;

  const directMeta =
    stringField(toolCall._meta, 'serverName') ??
    stringField(toolCall._meta, 'server') ??
    stringField(recordField(toolCall._meta, 'mcp'), 'server');
  if (directMeta) return directMeta;

  const toolId = stringField(toolCall.rawInput, 'tool_id');
  const namespaced = toolId?.split('::');
  if (namespaced && namespaced.length === 2 && namespaced[0]) return namespaced[0];

  const titleMatch = toolCall.title?.match(/^@([^/]+)\//);
  if (titleMatch?.[1]) return titleMatch[1];

  const raw = toolCall.rawInput as Record<string, unknown> | undefined;
  if (typeof raw?.server === 'string' && raw.server.length > 0) return raw.server;
  if (typeof raw?.serverName === 'string' && raw.serverName.length > 0) return raw.serverName;
  if (typeof raw?.providerIdentifier === 'string' && raw.providerIdentifier.length > 0)
    return raw.providerIdentifier;

  return undefined;
}

/**
 * Maps Kiro tool calls to Switch's ItemType.
 * Kiro subtasks and delegation tools map to 'subagent', while subagent internal calls
 * and ordinary tool calls remain untyped.
 */
export function kiroItemType(toolCall: AcpToolCall): ItemType | undefined {
  const kiro = recordField(toolCall._meta, 'kiro');
  if (stringField(kiro, 'kind') === 'agent-subtask') return 'subagent';
  if (toolCall.toolCallId.startsWith('invoke_subagent_')) return 'subagent';

  const toolId = stringField(toolCall.rawInput, 'tool_id');
  const name = toolId?.split('::').pop() ?? stringField(toolCall.rawInput, '_toolName');
  if (name === 'task' || (name !== undefined && /subagent/i.test(name))) return 'subagent';
  if (toolCall.title !== undefined && /sub-?agent/i.test(toolCall.title)) return 'subagent';
  if (toolCall.kind === 'subagent') return 'subagent';

  return undefined;
}

export const KNOWN_KIRO_OPTIONAL_METHODS = [
  'kiro/ask_question',
  'kiro/action',
  'kiro/decision',
  '_kiro.dev/commands/execute',
] as const;

/**
 * Checks whether an optional method is advertised in `agentCapabilities._meta.kiro.extensionMethods`.
 */
export function isKiroMethodAdvertised(
  capabilities: KiroAgentCapabilities | undefined,
  method: string
): boolean {
  const methods = capabilities?._meta?.kiro?.extensionMethods;
  return Array.isArray(methods) && methods.includes(method);
}

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
  promptCapabilities: { image: true },
  noLegacySetModel: true,
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp', '--agent-engine=v3'],
    env,
  }),
  loginCommand: KIRO_LOGIN,
  checkSignIn: checkKiroSignIn,
  mcpServerOf: kiroMcpServerOf,
  itemType: kiroItemType,
  onInitialized: (context, initialized, on) => {
    const agentCaps = initialized.agentCapabilities as KiroAgentCapabilities | undefined;
    const advertisedMethods = new Set(agentCaps?._meta?.kiro?.extensionMethods ?? []);

    for (const method of KNOWN_KIRO_OPTIONAL_METHODS) {
      if (advertisedMethods.has(method)) {
        on.request(method, async (params) => {
          return { acknowledged: true, params };
        });
        on.notification(method, (_params) => {
          // Safe handling for notifications
        });
      }
    }
  },
  extensions: (context: AcpSessionContext, on) => {
    // Explicit error returning for unadvertised extension calls
    for (const prefix of ['kiro/', '_kiro.dev/']) {
      for (const suffix of ['commands/execute', 'settings/update', 'custom_tool']) {
        const method = `${prefix}${suffix}`;
        on.request(method, async () => {
          const caps = context.agentCapabilities as KiroAgentCapabilities | undefined;
          if (!isKiroMethodAdvertised(caps, method)) {
            throw new JsonRpcError(
              -32601,
              `Method '${method}' is not supported: not advertised in agentCapabilities._meta.kiro.extensionMethods`
            );
          }
          return {};
        });
        on.notification(method, () => {
          // Unsupported notifications are safely ignored
        });
      }
    }
  },
};

export function createKiroAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(kiroAcp, options);
}
