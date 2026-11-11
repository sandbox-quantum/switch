import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpPermissionRequest, AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

const GOOSE_LOGIN = 'goose configure';

// Goose's bundled extensions, as `goose info -v` lists them. A tool call from
// any other extension is from an MCP server the session registered.
const GOOSE_EXTENSIONS = new Set([
  'analyze',
  'apps',
  'chatrecall',
  'code_execution',
  'developer',
  'Extension Manager',
  'scheduler',
  'skills',
  'summarize',
  'summon',
  'todo',
  'tom',
]);

// A new Goose session starts in the machine's GOOSE_MODE, `auto` unless set,
// which approves every tool call; so every session gets a mode. Goose keeps it
// on the session and never writes it to its config.
const GOOSE_MODES: Record<RuntimeMode, string> = {
  'approval-required': 'approve',
  'auto-accept-edits': 'approve',
  auto: 'smart_approve',
  'full-access': 'auto',
};

const ITEM_TYPES: Record<string, ItemType> = {
  'developer/shell': 'command_execution',
  'developer/write': 'file_change',
  'developer/edit': 'file_change',
  'summon/delegate': 'subagent',
};

function gooseTool(toolCall: AcpToolCall): { extension: string; tool: string } | undefined {
  const call = (toolCall._meta?.goose as { toolCall?: unknown } | undefined)?.toolCall as
    | { extensionName?: unknown; toolName?: unknown }
    | undefined;
  return typeof call?.extensionName === 'string' && typeof call.toolName === 'string'
    ? { extension: call.extensionName, tool: call.toolName }
    : undefined;
}

/** Reads the provider and model `goose info -v` resolves, from the environment or Goose's config. */
export function parseGooseInfo(output: string): ProviderReadiness {
  // pressly/goose, a database migration tool, installs a binary of the same name.
  if (!/^goose Version:/m.test(output))
    return readiness(
      'unknown',
      'The `goose` on PATH is not the Goose agent CLI. Install Goose from https://goose-docs.ai.'
    );
  const setting = (key: string) =>
    output.match(new RegExp(`^[ \\t]+${key}:[ \\t]*(\\S.*)$`, 'm'))?.[1]?.trim();
  const provider = setting('GOOSE_PROVIDER');
  const model = setting('GOOSE_MODEL');
  if (!provider || !model) return readiness('unauthenticated', signInWith(GOOSE_LOGIN));
  return readiness('authenticated', `Uses ${provider} (${model}).`);
}

/**
 * Goose's permission request carries no `_meta` and always the kind `other`,
 * only a title naming the tool (`shell · ls`, `write · notes.txt`), so the
 * kind is read from the title and the tool's arguments. It offers
 * `allow_always`, which Goose writes to its machine-wide `permission.yaml`,
 * outliving the session and covering every Goose session on the machine:
 * only the once options are kept, with readable labels.
 */
export function gooseRequest(request: AcpPermissionRequest): void {
  const { toolCall } = request;
  const tool = toolCall.title?.match(/^(\w+) · /)?.[1];
  const input = toolCall.rawInput ?? {};
  if (tool === 'shell' && typeof input.command === 'string') toolCall.kind = 'execute';
  else if ((tool === 'write' || tool === 'edit') && typeof input.path === 'string')
    toolCall.kind = 'edit';
  request.options = request.options.flatMap((option) =>
    option.kind === 'allow_once'
      ? [{ ...option, name: 'Allow once' }]
      : option.kind === 'reject_once'
        ? [{ ...option, name: 'Reject' }]
        : []
  );
}

/** Goose's `goose acp`, with its session modes and its tool and permission metadata. */
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
  inheritEnv: ['GOOSE_PROVIDER', 'GOOSE_MODEL', 'GOOSE_DISABLE_KEYRING'],
  // Goose has no account: it is ready once a provider and model are
  // configured. `initialize` offers the same `goose-provider` method either
  // way, so the handshake cannot tell. `goose info -v` resolves both without a
  // model call; the provider's key is taken as given, and a bad one fails the
  // first turn.
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    let output: string;
    try {
      output = (
        await execProvider(binaryPath, ['info', '-v'], {
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
  sessionMode: (mode) => GOOSE_MODES[mode],
  mcpServerOf: (toolCall) => {
    const extension = gooseTool(toolCall)?.extension;
    return extension !== undefined && !GOOSE_EXTENSIONS.has(extension) ? extension : undefined;
  },
  itemType: (toolCall) => {
    const call = gooseTool(toolCall);
    return call ? ITEM_TYPES[`${call.extension}/${call.tool}`] : undefined;
  },
  permission: (_context, request) => {
    gooseRequest(request);
    return undefined;
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
