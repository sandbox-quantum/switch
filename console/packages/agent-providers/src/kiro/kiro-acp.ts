import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import {
  commandOutput,
  readiness,
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

/**
 * Parses output from `kiro-cli whoami --format json` (or plaintext status messages)
 * to determine provider authentication state without prompting interactively.
 */
export function parseKiroWhoami(output: string): ProviderReadiness {
  const trimmed = output.trim();
  if (!trimmed) {
    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  }

  // Fast-path text matches for unauthenticated states (such as stderr or plain text replies)
  if (SIGNED_OUT_PATTERN.test(trimmed)) {
    return readiness('unauthenticated', KIRO_LOGIN_HINT);
  }

  try {
    const data = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof data !== 'object' || data === null) {
      return readiness('unknown', 'Could not verify authentication: malformed status output.');
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
      return readiness('authenticated', user ? `Signed in as ${user}.` : 'Signed in.');
    }

    const fallbackUser =
      (typeof data.email === 'string' && data.email) ||
      (typeof data.user === 'string' && data.user) ||
      (typeof data.username === 'string' && data.username);
    if (fallbackUser) {
      return readiness('authenticated', `Signed in as ${fallbackUser}.`);
    }

    return readiness(
      'unknown',
      'Could not verify authentication. Check provider setup and try again.'
    );
  } catch {
    return readiness('unknown', 'Could not verify authentication: malformed status output.');
  }
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
  label: 'Kiro',
  defaultBinary: 'kiro-cli',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  noLegacySetModel: true,
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp', '--agent-engine=v3'],
    env,
  }),
  loginCommand: KIRO_LOGIN,
  checkSignIn: checkKiroSignIn,
  mcpServerOf: (toolCall: AcpToolCall) => {
    const meta = toolCall._meta as
      | {
          server?: unknown;
          serverName?: unknown;
          mcp?: { server?: unknown };
          kiro?: { server?: unknown; serverName?: unknown };
        }
      | undefined;
    if (typeof meta?.kiro?.server === 'string') return meta.kiro.server;
    if (typeof meta?.kiro?.serverName === 'string') return meta.kiro.serverName;
    if (typeof meta?.server === 'string') return meta.server;
    if (typeof meta?.serverName === 'string') return meta.serverName;
    if (typeof meta?.mcp?.server === 'string') return meta.mcp.server;
    const raw = toolCall.rawInput as
      | { server?: unknown; serverName?: unknown; providerIdentifier?: unknown }
      | undefined;
    if (typeof raw?.server === 'string') return raw.server;
    if (typeof raw?.serverName === 'string') return raw.serverName;
    if (typeof raw?.providerIdentifier === 'string') return raw.providerIdentifier;
    return undefined;
  },
  itemType: (toolCall: AcpToolCall): ItemType | undefined => {
    if (
      toolCall.rawInput?._toolName === 'task' ||
      toolCall.title?.toLowerCase().startsWith('task:') ||
      toolCall.kind === 'subagent'
    ) {
      return 'subagent';
    }
    return undefined;
  },
  onInitialized: (context, initialized, on) => {
    const agentCaps = initialized.agentCapabilities as KiroAgentCapabilities | undefined;
    const advertisedMethods = new Set(agentCaps?._meta?.kiro?.extensionMethods ?? []);

    for (const method of KNOWN_KIRO_OPTIONAL_METHODS) {
      if (advertisedMethods.has(method)) {
        on.request(method, async (params) => {
          // Handlers for optional methods when advertised
          return { acknowledged: true, params };
        });
        on.notification(method, (_params) => {
          // Safe handling for notifications
        });
      }
    }
  },
  extensions: (context: AcpSessionContext, on) => {
    // Explicit error returning for legacy or unsupported extension calls
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
