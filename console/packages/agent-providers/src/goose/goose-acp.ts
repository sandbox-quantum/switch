import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpSessionUpdate } from '../acp/protocol';
import { readiness } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

interface GooseToolIdentity {
  extensionName?: unknown;
  toolName?: unknown;
}

function toolIdentity(toolCall: { _meta?: Record<string, unknown> }) {
  return (toolCall._meta as { goose?: { toolCall?: GooseToolIdentity } } | undefined)?.goose
    ?.toolCall;
}

// Goose 1.43.0 sends a permission request without `_meta`; the identity is on the
// tool_call update before it. Keyed by the session's context, which the adapter
// hands to both `extensions` and `permission`.
const identitiesBySession = new WeakMap<AcpSessionContext, Map<string, GooseToolIdentity>>();

function isBuiltin(
  context: AcpSessionContext,
  identity: GooseToolIdentity | undefined,
  extension: string
) {
  return identity?.extensionName === extension && !context.mcpServerNames.has(extension);
}

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
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    // Console sends MCP servers, causing Goose to omit its own extensions.
    args: ['acp', '--with-builtin', 'developer'],
    // Session hosts have no interactive keyring; never start in Goose's default auto mode.
    env: { ...env, GOOSE_DISABLE_KEYRING: '1', GOOSE_MODE: 'approve' },
  }),
  loginCommand: 'goose configure',
  inheritEnv: [
    'GOOSE_PROVIDER',
    'GOOSE_MODEL',
    'GOOSE_FAST_MODEL',
    'GOOSE_PATH_ROOT',
    'GOOSE_ADDITIONAL_CONFIG_FILES',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_STATE_HOME',
    'OLLAMA_HOST',
  ],
  checkSignIn: async (input) => {
    const client = new StdioJsonRpcClient({
      ...(await gooseAcp.launch(input)),
      cwd: input.cwd,
      logger: noopLogger,
      onExit: () => {},
    });
    try {
      await acpInitialize(client, gooseAcp);
      // Goose 1.43.0 resolves env, structured and legacy config without a model call.
      const defaults = await client.request<{
        providerId?: string | null;
        modelId?: string | null;
      }>('_goose/unstable/defaults/read', {});
      return defaults.providerId?.trim() && defaults.modelId?.trim()
        ? readiness(
            'authenticated',
            'Goose has a model provider configured; credentials are checked on the first turn.'
          )
        : readiness(
            'unconfigured',
            'Configure a model provider on the execution machine with goose configure.'
          );
    } finally {
      await client.dispose();
    }
  },
  // Verified with Goose 1.43.0 session/new and session/set_mode (2026-10-27).
  sessionMode: (mode) => {
    switch (mode) {
      case 'full-access':
        return 'auto';
      case 'auto-accept-edits':
      case 'auto':
        return 'smart_approve';
      case 'approval-required':
        return 'approve';
    }
  },
  extensions: (context, on) => {
    const identities = new Map<string, GooseToolIdentity>();
    identitiesBySession.set(context, identities);
    on.notification('session/update', (params) => {
      const update = (params as { update?: AcpSessionUpdate }).update;
      if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update')
        return;
      if (!update.toolCallId) return;
      const identity = toolIdentity(update);
      if (identity) identities.set(update.toolCallId, identity);
      if (update.status === 'completed' || update.status === 'failed')
        identities.delete(update.toolCallId);
    });
  },
  permission: (context, request) => {
    request.options = request.options.filter(
      (option) => option.kind === 'allow_once' || option.kind === 'reject_once'
    );
    const { toolCall, options } = request;
    // Titles are display text, never identity.
    const identity =
      toolIdentity(toolCall) ?? identitiesBySession.get(context)?.get(toolCall.toolCallId);
    if (toolCall.kind === 'other' && isBuiltin(context, identity, 'developer')) {
      if (identity?.toolName === 'shell') toolCall.kind = 'execute';
      if (identity?.toolName === 'write' || identity?.toolName === 'edit') toolCall.kind = 'edit';
    }
    if (!isBuiltin(context, identity, 'todo') || identity?.toolName !== 'todo__todo_write')
      return undefined;
    const once = options.find((option) => option.kind === 'allow_once');
    if (!once) return undefined;
    return Promise.resolve({ outcome: { outcome: 'selected', optionId: once.optionId } });
  },
  mcpServerOf: (toolCall) => {
    const name = toolIdentity(toolCall)?.extensionName;
    return typeof name === 'string' && name ? name : undefined;
  },
  itemType: (toolCall) => {
    switch (toolIdentity(toolCall)?.toolName) {
      case 'shell':
      case 'developer__shell':
        return 'command_execution';
      case 'write':
      case 'developer__write':
      case 'developer__edit':
        return 'file_change';
      case 'delegate':
      case 'summon__delegate':
        return 'subagent';
      default:
        return undefined;
    }
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
