import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { loadAll } from 'js-yaml';
import { z } from 'zod';
import { createAcpAdapter, type AcpAdapter } from '../acp/acp-adapter';
import type { AcpAdapterOptions, AcpProviderHooks } from '../acp/hooks';
import type { AcpToolCall } from '../acp/protocol';
import type { ItemType } from '../events';
import { readiness } from '../readiness';

const configSchema = z.object({
  GOOSE_PROVIDER: z.string().optional(),
  GOOSE_MODEL: z.string().optional(),
  active_provider: z.string().optional(),
  providers: z.record(z.string(), z.object({ model: z.string().optional() })).optional(),
});

export function gooseConfigDirectory(
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform
): string {
  if (env.GOOSE_PATH_ROOT && isAbsolute(env.GOOSE_PATH_ROOT))
    return join(env.GOOSE_PATH_ROOT, 'config');
  const home = env.HOME || env.USERPROFILE || homedir();
  if (platform === 'win32')
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Block', 'goose', 'config');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Block', 'goose');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'goose');
}

// Goose's own extensions (v1.57), which are not MCP servers a session registered.
const BUILT_IN_EXTENSIONS = new Set([
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

// What Goose's `developer` tools do, as ACP kinds and as Switch items.
const DEVELOPER_KINDS = new Map([
  ['shell', 'execute'],
  ['write', 'edit'],
  ['edit', 'edit'],
]);

// The options Switch offers, with the names Goose leaves as their ids.
const OPTION_NAMES = new Map([
  ['allow_once', 'Allow once'],
  ['reject_once', 'Reject'],
]);

const DEVELOPER_ITEM_TYPES = new Map<unknown, ItemType>([
  ['shell', 'command_execution'],
  ['write', 'file_change'],
  ['edit', 'file_change'],
]);

function gooseToolCall(
  toolCall: AcpToolCall
): { toolName?: unknown; extensionName?: unknown } | undefined {
  const meta = toolCall._meta as
    | { goose?: { toolCall?: { toolName?: unknown; extensionName?: unknown } } }
    | undefined;
  return meta?.goose?.toolCall;
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
  // Switch never shows Goose's own session names, and naming a session is a
  // model call of its own, so it is off unless the machine turns it on.
  launch: ({ binaryPath, env }) => ({
    command: binaryPath,
    args: ['acp'],
    env: { GOOSE_DISABLE_SESSION_NAMING: 'true', ...env, GOOSE_MODE: 'approve' },
  }),
  loginCommand: 'goose configure',
  inheritEnv: [
    'GOOSE_PROVIDER',
    'GOOSE_MODEL',
    'GOOSE_PATH_ROOT',
    'GOOSE_DISABLE_KEYRING',
    'GOOSE_DISABLE_SESSION_NAMING',
    'GOOSE_ADDITIONAL_CONFIG_FILES',
    // Goose model providers whose keys the shared list does not carry.
    'GROQ_API_KEY',
  ],
  checkSignIn: async ({ env, handshake }) => {
    // pressly/goose, a database migration tool, is also installed as `goose`.
    const agent = await handshake().then(
      (result) => result.agentInfo?.name,
      () => undefined
    );
    if (agent !== 'goose')
      return readiness(
        'unknown',
        'The goose on this machine did not start as Block Goose (goose acp). If it is pressly/goose, the database migration tool, install Block Goose ahead of it on PATH.'
      );
    let config: z.infer<typeof configSchema> = {};
    if (!env.GOOSE_PROVIDER?.trim() || !env.GOOSE_MODEL?.trim()) {
      try {
        // `loadAll`, unlike `load`, reads an empty or comment-only file as no document.
        const [document] = loadAll(
          await readFile(join(gooseConfigDirectory(env), 'config.yaml'), 'utf8')
        );
        config = configSchema.parse(document ?? {});
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          return readiness(
            'unknown',
            'Could not read Goose configuration. Run goose configure on the execution machine.'
          );
      }
    }
    const provider = env.GOOSE_PROVIDER?.trim() || config.active_provider || config.GOOSE_PROVIDER;
    const model =
      env.GOOSE_MODEL?.trim() ||
      (provider ? config.providers?.[provider]?.model : undefined) ||
      config.GOOSE_MODEL;
    // Configuration is checked without accessing a keyring or making a model call.
    return provider?.trim() && model?.trim()
      ? readiness(
          'authenticated',
          'Goose has a model provider configured. Credentials are checked on the first turn.'
        )
      : readiness(
          'unconfigured',
          'Configure a model provider on the execution machine with goose configure, or set GOOSE_PROVIDER and GOOSE_MODEL with its credentials.'
        );
  },
  sessionMode: (mode) => {
    switch (mode) {
      case 'full-access':
        return 'auto';
      case 'auto':
        return 'smart_approve';
      // Let Switch approve edits and ask about every other tool.
      case 'auto-accept-edits':
      case 'approval-required':
        return 'approve';
    }
  },
  mcpServerOf: (toolCall) => {
    const name = gooseToolCall(toolCall)?.extensionName;
    return typeof name === 'string' && name && !BUILT_IN_EXTENSIONS.has(name) ? name : undefined;
  },
  itemType: (toolCall) => {
    const call = gooseToolCall(toolCall);
    if (call?.extensionName === 'developer') return DEVELOPER_ITEM_TYPES.get(call.toolName);
    // Goose's subagents are the `delegate` tool of its `summon` extension.
    return call?.toolName === 'delegate' && call.extensionName === 'summon'
      ? 'subagent'
      : undefined;
  },
  // Goose sends every tool call without an ACP kind, and its permission
  // requests without `_meta`, so the title names the tool: `shell · ls`.
  permission: (_context, request) => {
    const kind = DEVELOPER_KINDS.get(request.toolCall.title?.split(' · ')[0] ?? '');
    if (kind) request.toolCall.kind = kind;
    // Goose saves `allow_always` to its permission.yaml for good, so it is not
    // offered; its options are named after their ids, so they are named here.
    request.options = request.options.flatMap((option) => {
      const name = OPTION_NAMES.get(option.kind);
      return name ? [{ ...option, name: option.name === option.kind ? name : option.name }] : [];
    });
    return undefined;
  },
};

export function createGooseAdapter(options: AcpAdapterOptions = {}): AcpAdapter {
  return createAcpAdapter(gooseAcp, options);
}
