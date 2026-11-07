import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, type ProviderReadiness } from '../readiness';

const GOOSE_LOGIN = 'goose configure';
const UNVERIFIED = 'Could not verify the Goose setup. Check provider setup and try again.';

/**
 * Reads `goose info --verbose`, which prints the configuration Goose would run
 * with, its environment included (`GOOSE_PROVIDER` overrides config.yaml).
 * Goose has no account of its own: it is ready once a model provider is chosen.
 * The provider's key is not checked, since only a model request could check it.
 */
export function parseGooseInfo(output: string): ProviderReadiness {
  const config = output.split(/^goose Configuration:[ \t]*$/m)[1];
  if (config === undefined) return readiness('unknown', UNVERIFIED);
  const setting = (key: string) =>
    config
      .match(new RegExp(`^ {2}${key}:[ \\t]*(.*)$`, 'm'))?.[1]
      ?.trim()
      .replace(/^(['"])(.*)\1$/, '$2');
  const provider = setting('GOOSE_PROVIDER');
  if (!provider)
    return readiness(
      'unconfigured',
      `Goose has no model provider. Choose one on the execution machine with ${GOOSE_LOGIN}.`
    );
  const model = setting('GOOSE_MODEL');
  return readiness(
    'authenticated',
    `Goose uses ${provider}${model ? ` (${model})` : ''}. Its key is checked by the first turn.`
  );
}

/** The ACP kinds of Goose's developer tools, which Goose reports as `other`. */
const DEVELOPER_KINDS = new Map([
  ['shell', 'execute'],
  ['write', 'edit'],
  ['edit', 'edit'],
]);

/** The tool and extension Goose names in a tool call's `_meta.goose.toolCall`. */
function gooseTool(toolCall: AcpToolCall): { toolName?: string; extensionName?: string } {
  const named = (toolCall._meta as { goose?: { toolCall?: unknown } } | undefined)?.goose?.toolCall;
  if (typeof named !== 'object' || named === null) return {};
  const { toolName, extensionName } = named as Record<string, unknown>;
  return {
    ...(typeof toolName === 'string' ? { toolName } : {}),
    ...(typeof extensionName === 'string' ? { extensionName } : {}),
  };
}

/** Goose's `goose acp`, on whichever model provider the person configured for it. */
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
  // Goose takes its provider and model from these when they are set, and its
  // providers' keys and hosts from the variables of the same name.
  inheritEnv: [
    'GOOSE_PROVIDER',
    'GOOSE_MODEL',
    'GOOSE_DISABLE_KEYRING',
    'OPENAI_HOST',
    'OPENAI_BASE_PATH',
    'OLLAMA_HOST',
    'DATABRICKS_HOST',
    'DATABRICKS_TOKEN',
    'GCP_PROJECT_ID',
    'GROQ_API_KEY',
    'DEEPSEEK_API_KEY',
    'LITELLM_API_KEY',
  ],
  // `info --verbose` only reads the configuration. The handshake cannot tell:
  // Goose lists its `goose-provider` auth method whether or not a provider is
  // set, and its `authenticate` does nothing. `info --check` would send a
  // model request.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['info', '--verbose'], {
          cwd,
          env,
          timeout: 15000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      output = commandOutput(error);
    }
    return parseGooseInfo(output);
  },
  // Goose's modes are permission levels, and a new session starts in `auto`
  // (no prompts) unless told otherwise. `smart_approve` is Goose's own
  // reviewer: it runs what it judges read-only and asks for the rest.
  sessionMode: (runtimeMode) => {
    switch (runtimeMode) {
      case 'full-access':
        return 'auto';
      case 'auto':
        return 'smart_approve';
      case 'auto-accept-edits':
      case 'approval-required':
        return 'approve';
    }
  },
  // Goose saves `allow_always` to its permission.yaml, where it skips the
  // question for that tool in every later session, so it is not offered as
  // allow for this session. Its requests type every tool as `other`; the
  // developer tools are told apart by the title Goose gives them ("shell · ls").
  permissionRequest: (request) => {
    const { toolCall } = request;
    const kind =
      !toolCall.kind || toolCall.kind === 'other'
        ? DEVELOPER_KINDS.get(toolCall.title?.match(/^(\w+)(?: · |$)/)?.[1] ?? '')
        : undefined;
    return {
      ...request,
      toolCall: kind ? { ...toolCall, kind } : toolCall,
      options: request.options.filter((option) => option.kind !== 'allow_always'),
    };
  },
  // An MCP server's tools are named `<server>__<tool>`; Goose's built-in tools
  // carry their extension's name too but are not prefixed with it.
  mcpServerOf: (toolCall) => {
    const { toolName, extensionName } = gooseTool(toolCall);
    return extensionName && toolName?.startsWith(`${extensionName}__`) ? extensionName : undefined;
  },
  itemType: (toolCall) => {
    const { toolName, extensionName } = gooseTool(toolCall);
    if (extensionName === 'summon' && toolName === 'delegate') return 'subagent';
    if (extensionName !== 'developer') return undefined;
    const kind = DEVELOPER_KINDS.get(toolName ?? '');
    return kind === 'execute' ? 'command_execution' : kind === 'edit' ? 'file_change' : undefined;
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
