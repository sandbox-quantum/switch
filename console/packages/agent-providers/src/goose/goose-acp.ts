import { acpInitialize, createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { readiness } from '../readiness';
import { noopLogger, StdioJsonRpcClient } from '../transport/stdio-json-rpc';

function toolIdentity(toolCall: AcpToolCall) {
  return (
    toolCall._meta as
      | { goose?: { toolCall?: { extensionName?: unknown; toolName?: unknown } } }
      | undefined
  )?.goose?.toolCall;
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
    'GOOSE_DISABLE_KEYRING',
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
  permission: (_context, request) => {
    request.options = request.options.filter(
      (option) => option.kind === 'allow_once' || option.kind === 'reject_once'
    );
    const { toolCall, options } = request;
    if (toolCall.kind === 'other' && toolCall._meta == null) {
      const prefix = /^(shell|write|edit) · /.exec(toolCall.title ?? '')?.[1];
      if (prefix) toolCall.kind = prefix === 'shell' ? 'execute' : 'edit';
    }
    const name = toolIdentity(toolCall)?.toolName;
    const todo =
      name === 'todo__todo_write' || (name === undefined && toolCall.title === 'todo: todo write');
    if (!todo) return undefined;
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
