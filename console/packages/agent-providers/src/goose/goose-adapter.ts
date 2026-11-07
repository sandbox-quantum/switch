import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpPermissionRequest, AcpSessionModes, AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { ItemType } from '../events';
import { readiness } from '../readiness';
import { JsonRpcError } from '../transport/stdio-json-rpc';

export const GOOSE_LOGIN = 'goose configure';
const UNCONFIGURED = /Configuration value not found/i;

/**
 * Goose starts every session in `auto`, which approves every tool call, so a
 * session is always put in a mode of its own. Its `smart_approve` mode asked
 * for the same calls as `approve` when measured (1.57.0), so auto mode asks
 * the way approval-required does; full access is `auto`, where Goose asks for
 * nothing.
 */
const MODES: Record<RuntimeMode, string> = {
  'full-access': 'auto',
  auto: 'approve',
  'auto-accept-edits': 'approve',
  'approval-required': 'approve',
};

/**
 * The Goose mode for `runtimeMode`. A mode that asks is refused when Goose
 * does not offer it: leaving the session in `auto` would approve everything
 * unseen.
 */
export function gooseSessionMode(
  runtimeMode: RuntimeMode,
  modes: AcpSessionModes | undefined
): string | undefined {
  const mode = MODES[runtimeMode];
  if (modes?.availableModes.some((offered) => offered.id === mode)) return mode;
  if (runtimeMode === 'full-access') return undefined;
  throw new Error(
    `Goose does not offer its "${mode}" mode (it offers: ${modes?.availableModes.map((offered) => offered.id).join(', ') || 'none'}), so a ${runtimeMode} session cannot be made to ask before it acts.`
  );
}

interface GooseToolMeta {
  toolName?: unknown;
  extensionName?: unknown;
}

function gooseTool(toolCall: AcpToolCall): GooseToolMeta | undefined {
  const goose = toolCall._meta?.goose as { toolCall?: GooseToolMeta } | undefined;
  return goose?.toolCall;
}

/**
 * Goose names a tool on an MCP server `<server>__<tool>` and sends the server
 * as the extension. Its own developer tools are unprefixed (`shell`, `write`).
 */
export function gooseMcpServer(toolCall: AcpToolCall): string | undefined {
  const { toolName, extensionName } = gooseTool(toolCall) ?? {};
  return typeof toolName === 'string' &&
    typeof extensionName === 'string' &&
    toolName.startsWith(`${extensionName}__`)
    ? extensionName
    : undefined;
}

/** Goose sends every tool call without a `kind`, so its tools are typed by name. */
export function gooseItemType(toolCall: AcpToolCall): ItemType | undefined {
  const { toolName, extensionName } = gooseTool(toolCall) ?? {};
  if (extensionName === 'developer' && toolName === 'shell') return 'command_execution';
  if (extensionName === 'developer' && (toolName === 'write' || toolName === 'edit'))
    return 'file_change';
  if (extensionName === 'summon' && toolName === 'delegate') return 'subagent';
  return undefined;
}

const ASKS: Record<string, { kind: 'execute' | 'edit'; input: string }> = {
  shell: { kind: 'execute', input: 'command' },
  write: { kind: 'edit', input: 'path' },
  edit: { kind: 'edit', input: 'path' },
};

/**
 * Restates a permission request before the adapter's policy decides it.
 * Goose names its options after their ids and saves `allow_always` to its
 * global `permission.yaml`, which would silence the tool in every later
 * session; only allow once and reject are offered. Its permission requests
 * carry no `_meta` and the kind `other`, so its developer tools are typed
 * from the `<tool> · <detail>` title and the input they take, which lets
 * auto-accept-edits tell an edit from a command. Anything else is left
 * as `other` and asks.
 */
export function restateGoosePermission(request: AcpPermissionRequest): void {
  const labels: Record<string, string> = { allow_once: 'Allow once', reject_once: 'Reject' };
  request.options = request.options
    .filter((option) => option.kind in labels)
    .map((option) => ({ ...option, name: labels[option.kind]! }));
  const { toolCall } = request;
  const tool = toolCall.title?.split(' · ', 2)[0];
  const ask = tool === undefined ? undefined : ASKS[tool];
  if (ask && toolCall.title?.includes(' · ') && typeof toolCall.rawInput?.[ask.input] === 'string')
    toolCall.kind = ask.kind;
}

/** Goose's `goose acp`, on whichever model provider the owner configured. */
export const gooseAcp: AcpProviderHooks = {
  provider: 'goose',
  label: 'Goose',
  defaultBinary: 'goose',
  capabilities: {
    modelSwitchInSession: true,
    steering: false,
    resume: true,
    approvals: true,
    userInput: false,
  },
  launch: ({ binaryPath, env }) => ({ command: binaryPath, args: ['acp'], env }),
  loginCommand: GOOSE_LOGIN,
  // Goose has no account of its own, and `initialize` offers the same
  // `goose-provider` method whether or not a model provider is set up. A new
  // session is refused when no provider and model are configured (in the
  // environment or Goose's config) and is otherwise created without a model
  // call, and the session is deleted at once, so asking for one signs nothing
  // in and leaves nothing behind. The provider's key is not checked: a wrong
  // one fails the first turn.
  checkSignIn: async ({ cwd, handshake, request }) => {
    await handshake();
    try {
      const { sessionId } = await request<{ sessionId: string }>('session/new', {
        cwd,
        mcpServers: [],
      });
      // Goose stores the session it creates, so the check removes it again.
      await request('session/delete', { sessionId });
    } catch (error) {
      if (error instanceof JsonRpcError && UNCONFIGURED.test(String(error.data ?? error.message)))
        return readiness(
          'unconfigured',
          `Goose has no model provider and model configured. Run ${GOOSE_LOGIN} on the execution machine, or set GOOSE_PROVIDER and GOOSE_MODEL.`
        );
      throw error;
    }
    return readiness(
      'authenticated',
      "A model provider and model are configured. Goose checks the provider's key on the first turn."
    );
  },
  inheritEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_DISABLE_KEYRING'],
  sessionMode: gooseSessionMode,
  mcpServerOf: gooseMcpServer,
  itemType: gooseItemType,
  permission: (_context, request) => {
    restateGoosePermission(request);
    return undefined;
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
