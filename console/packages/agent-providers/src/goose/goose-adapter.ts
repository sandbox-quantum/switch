import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks, AcpSessionContext } from '../acp/hooks';
import type { AcpPermissionOption, AcpPermissionRequest, AcpToolCall } from '../acp/protocol';
import type { RuntimeMode } from '../adapter';
import type { ItemType } from '../events';
import { execProvider } from '../provider-process';
import { commandOutput, readiness, signInWith, type ProviderReadiness } from '../readiness';

export const GOOSE_LOGIN = 'goose configure';

const BUILTIN_EXTENSIONS = new Set(['developer', 'summon']);

const GOOSE_MODES: Record<RuntimeMode, string> = {
  'approval-required': 'approve',
  'auto-accept-edits': 'approve',
  auto: 'smart_approve',
  'full-access': 'auto',
};

/** Extracts vendor tool metadata from Goose's `_meta` block when present. */
export function gooseToolMeta(
  call: AcpToolCall
): { extensionName?: string; toolName?: string } | undefined {
  const meta = call._meta as
    | { goose?: { toolCall?: { extensionName?: string; toolName?: string } } }
    | undefined;
  return meta?.goose?.toolCall;
}

/**
 * Returns the name of the MCP server that provided this tool, or `undefined`
 * for built-in tools (`developer`, `summon`). Goose names ACP-provided server
 * tools `<server>__<tool>` and sets `extensionName` to the server name.
 */
export function gooseMcpServerOf(toolCall: AcpToolCall): string | undefined {
  const meta = gooseToolMeta(toolCall);
  const ext = meta?.extensionName;
  if (ext && !BUILTIN_EXTENSIONS.has(ext)) {
    return ext;
  }
  const tool = meta?.toolName;
  if (tool && tool.includes('__')) {
    const prefix = tool.split('__')[0];
    if (!BUILTIN_EXTENSIONS.has(prefix)) {
      return prefix;
    }
  }
  return undefined;
}

/**
 * Maps Goose's built-in developer and summon tools to Switch's item types.
 */
export function gooseItemType(toolCall: AcpToolCall): ItemType | undefined {
  const meta = gooseToolMeta(toolCall);
  const toolName = meta?.toolName;
  const extName = meta?.extensionName;
  const title = toolCall.title ?? '';

  if (
    toolName === 'developer__shell' ||
    (extName === 'developer' && toolName === 'shell') ||
    /^developer:\s*shell\b/i.test(title)
  ) {
    return 'command_execution';
  }

  if (
    toolName === 'developer__write' ||
    toolName === 'developer__edit' ||
    (extName === 'developer' && (toolName === 'write' || toolName === 'edit')) ||
    /^developer:\s*(write|edit)\b/i.test(title)
  ) {
    return 'file_change';
  }

  if (
    toolName === 'summon__delegate' ||
    (extName === 'summon' && toolName === 'delegate') ||
    /^summon:\s*delegate\b/i.test(title)
  ) {
    return 'subagent';
  }

  return undefined;
}

/**
 * Strips ANSI terminal styling and checks for pressly/goose and configured
 * provider and model keys from `goose info -v`.
 */
export function parseGooseInfo(output: string): ProviderReadiness {
  // Distinguish pressly/goose (a database migration tool sharing the same binary name).
  if (
    /pressly|dbstring|database migration|migration tool|unknown command ["']?info/i.test(output)
  ) {
    return readiness(
      'unknown',
      'Found a non-Goose binary named "goose" on PATH. Ensure the Block/aaif-goose CLI is installed.'
    );
  }

  if (/not configured|no provider configured|run goose configure/i.test(output)) {
    return readiness('unauthenticated', signInWith(GOOSE_LOGIN));
  }

  const clean = output.replace(/\u001b\[[0-9;]*m/g, '');
  const providerMatch = clean.match(/(?:provider|goose_provider)\s*[:=]\s*([^\r\n]+)/i);
  const modelMatch = clean.match(/(?:model|goose_model)\s*[:=]\s*([^\r\n]+)/i);

  const provider = providerMatch?.[1]?.trim();
  const model = modelMatch?.[1]?.trim();

  const isUnset = (val?: string) =>
    !val || /^(none|not set|unset|<none>|null|undefined)$/i.test(val);

  if (!provider || isUnset(provider) || !model || isUnset(model)) {
    return readiness('unauthenticated', signInWith(GOOSE_LOGIN));
  }

  return readiness('authenticated', 'Signed in.');
}

/**
 * Intercepts Goose permission requests:
 * 1. Removes `allow_always` and `reject_always` because Goose permanently writes
 *    `allow_always` to machine-wide `permission.yaml`. Switch session UI only
 *    offers per-turn (`allow_once`) and decline (`reject_once`).
 * 2. Classifies `toolCall.kind` for developer shell/edit tools so the generic
 *    adapter can auto-accept edits in `auto-accept-edits` mode and ask with the
 *    proper approval request type.
 * Returns `undefined` to let the generic ACP adapter complete the decision.
 */
export function goosePermission(
  _context: AcpSessionContext,
  request: AcpPermissionRequest
): Promise<unknown> | undefined {
  const onceOrReject = request.options.filter(
    (opt: AcpPermissionOption) => opt.kind === 'allow_once' || opt.kind === 'reject_once'
  );
  if (onceOrReject.length > 0) {
    request.options = onceOrReject.map((opt: AcpPermissionOption) => ({
      ...opt,
      name:
        opt.name && opt.name !== opt.kind
          ? opt.name
          : opt.kind === 'allow_once'
            ? 'Allow once'
            : 'Reject',
    }));
  }

  const title = request.toolCall.title ?? '';
  const meta = gooseToolMeta(request.toolCall);
  const toolName = meta?.toolName ?? '';
  const extName = meta?.extensionName ?? '';

  if (
    toolName === 'developer__shell' ||
    (extName === 'developer' && toolName === 'shell') ||
    /^developer:\s*shell\b/i.test(title)
  ) {
    request.toolCall.kind = 'execute';
  } else if (
    toolName === 'developer__write' ||
    toolName === 'developer__edit' ||
    (extName === 'developer' && (toolName === 'write' || toolName === 'edit')) ||
    /^developer:\s*(write|edit)\b/i.test(title)
  ) {
    request.toolCall.kind = 'edit';
  }

  return undefined;
}

/** Goose's `goose acp`, with its permission mapping, session modes, and provider readiness. */
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
  checkSignIn: async ({ binaryPath, cwd, env }) => {
    if (env.GOOSE_PROVIDER?.trim() && env.GOOSE_MODEL?.trim()) {
      return readiness('authenticated', 'Signed in with configured Goose provider and model.');
    }
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
  promptCapabilities: { image: true, embeddedContext: true },
  sessionMode: (mode) => GOOSE_MODES[mode],
  mcpServerOf: gooseMcpServerOf,
  itemType: gooseItemType,
  permission: goosePermission,
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
